/**
 * Daytona Sandbox Provider
 *
 * @requires @daytonaio/sdk >= 0.203.0 (cursor-based list pagination; Daytona
 *   retired the page-numbered endpoint on 2026-06-25)
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
import type {
  GpuType,
  ListSandboxesQuery,
  Sandbox as DaytonaSandbox,
  SandboxState as DaytonaApiSandboxState,
} from "@daytonaio/sdk";
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
 * How long a create that LOST a snapshot name race waits for the winner's
 * build before giving up. Same budget the build path already spends on its own
 * snapshot create and on the sandbox create that follows it ({ timeout: 600 }),
 * and the same number Harbor waits — see
 * REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:306-311
 * (`_wait_for_active`, `timeout: int = 600`).
 */
export const DAYTONA_SNAPSHOT_CONFLICT_TIMEOUT_MS = 600_000;

/** Harbor polls the losing side every 5s (snapshots.py:312-313). */
const DAYTONA_SNAPSHOT_CONFLICT_POLL_MS = 5_000;

/**
 * Clocks of a STREAMED run (see awaitStreamedExit). The poll that reads the
 * command's exit code backs off from pollMin to pollMax. A follow whose
 * command has already ended is cut once it has been SILENT for drainMs —
 * silence, never elapsed time, so a stream still delivering is never
 * truncated. killGrace is what the caller's timeoutMs is widened by before a
 * streamed run gives up, because withInBoxTimeout kills with `timeout -k 10`:
 * the box may legitimately take ten seconds past the deadline to record a
 * status. And a follow that has CLOSED means the command ended, so its record
 * must catch up within settleMs — the only backstop a caller who passed no
 * timeoutMs has, which is why it is generous rather than tight.
 */
export const DAYTONA_STREAM_TIMINGS = {
  pollMinMs: 250,
  pollMaxMs: 2_000,
  drainMs: 1_000,
  killGraceMs: 15_000,
  settleMs: 60_000,
};

export type DaytonaStreamTimings = typeof DAYTONA_STREAM_TIMINGS;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Sandboxes requested per list fetch — the cursor API's per-page size
 * (ListSandboxesQuery.limit bounds one fetch, never the total). Held at the
 * value every provider in this lineup accepts, so one number is valid
 * everywhere a fleet is enumerated.
 */
export const DAYTONA_LIST_PAGE_SIZE = 100;

/**
 * Row ceiling for one enumeration — the same 10,000 sandboxes the old
 * 100-pages-of-100 ceiling allowed, restated in rows because cursor pagination
 * has no page numbers to count. A walk that reaches it stops and reports
 * itself INCOMPLETE, because the one thing a fleet enumeration may never do is
 * return a short list that reads like a whole one.
 */
export const DAYTONA_MAX_LIST_SCAN = 10_000;

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
/**
 * @deprecated No longer thrown. @daytonaio/sdk 0.203.0 grew a real
 * `Resources.gpuType` field, so `resources.gpuTypes` is now FORWARDED on the
 * snapshot-build path instead of refused (Daytona validates the type names
 * server-side). Sizing against an EXISTING snapshot — GPU type included —
 * still throws DaytonaResourcesError like every other pinned field. The class
 * stays exported so callers with `instanceof` checks keep compiling.
 */
export class DaytonaGpuTypeError extends Error {
  /** The snapshot/image the create named. */
  readonly snapshot: string;

  constructor(snapshot: string) {
    super(
      `Daytona cannot constrain the GPU type for "${snapshot}": the snapshot already exists ` +
        "and pins its resources — pre-build a snapshot with the desired GPU type under its own name."
    );
    this.name = "DaytonaGpuTypeError";
    this.snapshot = snapshot;
  }
}

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
    await sleep(pollMs);
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

/**
 * Typed error for a name race this run could not wait out: the winner never
 * finished inside the budget, or the wait itself became impossible (rejected
 * credentials, a control plane that stopped answering). Either way there is
 * nothing to reuse and nothing has failed either — the only honest answer is
 * to say so.
 *
 * Deliberately NOT a direct-pull trigger: a second copy of a build that is
 * still running would double the spend on the same image and hide a provider
 * incident behind a slow success.
 */
export class DaytonaSnapshotConflictError extends Error {
  /** The contended snapshot name. */
  readonly snapshot: string;

  constructor(snapshot: string, detail: string) {
    super(
      `Daytona snapshot "${snapshot}" is being created by another process and this run could not ` +
        `wait it out: ${detail}.`
    );
    this.name = "DaytonaSnapshotConflictError";
    this.snapshot = snapshot;
  }
}

/**
 * The wait's answer when the NAME IS GONE. A healer (this one, or the same code
 * in another process) can delete a dead snapshot while a second caller is
 * waiting on it, and that waiter must not read the resulting 404s as the
 * control plane failing — the thing it was waiting for cannot arrive, and the
 * name is now free to build. A symbol rather than a state string so it can
 * never collide with a state Daytona invents later.
 */
export const DAYTONA_SNAPSHOT_GONE = Symbol("daytona-snapshot-gone");

/**
 * The slice of the Daytona client the conflict wait touches — structural, so
 * the unit tests can drive it with a plain mock.
 */
interface SnapshotWaitClient {
  snapshot: {
    get(name: string): Promise<{ state?: string } | undefined>;
  };
}

/**
 * Snapshot states that mean "a build is in flight for this name" — the only
 * states worth waiting on. Everything outside this set is an answer: `active`
 * is a cache hit, `inactive` is the exists-but-asleep case the fast path
 * heals, and `error` / `build_failed` / `removing` are the end of the line.
 *
 * The set is a WHITELIST rather than a blacklist of failures on purpose: an
 * unknown state (a new one Daytona adds, or the API's
 * UNKNOWN_DEFAULT_OPEN_API) resolves the wait instead of polling a name that
 * is going nowhere for the full budget.
 */
const DAYTONA_SNAPSHOT_IN_FLIGHT_STATES = new Set([
  "pending",
  "pulling",
  "building",
  "snapshotting",
]);

/**
 * How many CONSECUTIVE identical poll failures end the wait. A control plane
 * that answers the same error three times in a row is not a transient blip,
 * and this wait has no outer retry to catch it (see the divergence note on
 * waitForSnapshotConflictWinner).
 */
const DAYTONA_SNAPSHOT_POLL_FAILURE_LIMIT = 3;

/** HTTP status carried by a Daytona SDK / axios error, wherever it hides. */
function httpStatusOf(err: unknown): number | undefined {
  const e = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  } | null;
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}

/**
 * Snapshot states that hold no usable image and never will. A name sitting in
 * one of these is not a cache entry, it is a headstone.
 */
const DAYTONA_SNAPSHOT_DEAD_STATES = new Set(["error", "build_failed"]);

/**
 * Tags Daytona's snapshot builder refuses outright. Its own documentation:
 * the base image "must include either a tag or a digest (e.g. `ubuntu:22.04`)"
 * and "the `latest`/`lts`/`stable` tags are not supported"
 * (https://www.daytona.io/docs/en/snapshots/).
 */
const DAYTONA_UNBUILDABLE_TAGS = new Set(["latest", "lts", "stable"]);

/**
 * MAY THIS PROVIDER DELETE THE SNAPSHOT BEHIND THIS NAME? — our answer to the
 * question Harbor answers with SnapshotPolicy.
 *
 * Harbor deletes an ERROR-state snapshot and rebuilds it under AUTO, and
 * refuses loudly under EXPLICIT, where the name is one the USER supplied for a
 * snapshot they manage
 * (REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:200-212).
 * This provider has no policy flag, so the split has to be derived from the
 * name itself — and there is a sharper criterion available than "who typed it":
 * CAN WE PUT IT BACK?
 *
 * THE TEST IS ON THE RESOLVED IMAGE, NOT THE NAME, and that distinction is the
 * whole of it. The build path creates a snapshot from
 * `IMAGE_MAP[imageName] ?? imageName`, so the question "can we rebuild it" is a
 * question about THAT ref, and Daytona will only build one carrying a real tag
 * or digest. Testing the name instead got the platform's own legacy alias
 * exactly wrong: `evolve-all` is an IMAGE_MAP key, which looked like proof we
 * own it — but it resolves to the UNTAGGED `evolvingmachines/evolve-all`, which
 * Daytona refuses to build. Delete would have succeeded, the rebuild would have
 * been refused, and the name would be gone: the precise harm this predicate
 * exists to prevent, committed on our own default. Reading the resolved ref
 * also closes the blind spot a bare `includes("/")` had, since a registry path
 * with no tag is just as unbuildable.
 *
 * When the ref does not qualify, the name belongs to a snapshot record that
 * exists only in the user's account — built by their own tooling,
 * unreproducible from here — and deleting it would throw away something nothing
 * in this process could recreate. That is exactly the harm Harbor's EXPLICIT
 * branch refuses, arrived at without a policy the caller must remember to set.
 *
 * Bare labels (`eval-env-<hash>`, `my-team-env`) are excluded and STILL HEALED,
 * just not here: the layer that authored the name owns rebuilding it. The eval
 * platform deletes and rebuilds its own `eval-env-*` aliases in its image
 * preparation path (swarm_dashboard lib/evaluations/worker/templates.ts,
 * commit 3f51b8d, merged to project-sable as 6ee52ed) — the same rule this
 * function states, applied one floor up.
 *
 * A REFINEMENT DELIBERATELY NOT BUILT: the sharpest provenance seam available
 * is `config.snapshotName` — a name the CALLER pinned is explicit by
 * construction, where the derived default (`evolve-all-<version>`) is ours by
 * construction. Threading that distinction from the constructor to here would
 * beat any inference from the ref, and it is where this should go if the
 * question is ever reopened. It is not built today because the resolved-ref
 * test already refuses everything unbuildable, which is the harm that matters.
 */
function providerCanRebuildSnapshot(imageName: string): boolean {
  const resolved = IMAGE_MAP[imageName] ?? imageName;
  // A digest pin is the strongest form and needs no tag — but it must actually
  // BE a digest. A bare `@` would have judged `team@prod` rebuildable, which is
  // the same harm as the untagged case in its last remaining shape.
  if (/@[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-f]{32,}$/i.test(resolved)) return true;
  // The tag lives in the LAST path segment, so a registry port
  // (localhost:5000/img) is never mistaken for one.
  const lastSegment = resolved.substring(resolved.lastIndexOf("/") + 1);
  const colon = lastSegment.lastIndexOf(":");
  if (colon < 0) return false;
  const tag = lastSegment.substring(colon + 1);
  if (tag === "") return false;
  return !DAYTONA_UNBUILDABLE_TAGS.has(tag.toLowerCase());
}

/**
 * Does this failure mean the snapshot is not there? Used for two opposite-
 * looking purposes that are really the same one: confirming a delete took
 * effect, and recognising that a name someone was waiting on has been cleared.
 */
function isMissingSnapshot(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("not found") || m.includes("404") || m.includes("does not exist");
}

/** How long to wait for a delete to actually take effect, and how often to look. */
const DAYTONA_SNAPSHOT_DELETE_TIMEOUT_MS = 60_000;
const DAYTONA_SNAPSHOT_DELETE_POLL_MS = 2_000;

/**
 * Delete a dead snapshot so the name is free to be built again. Reports whether
 * the name is now CONFIRMED CLEAR.
 *
 * THE DELETE IS ASYNCHRONOUS, and treating it as instant is what made the first
 * version of this heal itself deferred by a run: Daytona acknowledges the call
 * and moves the snapshot to `Removing`, so a create fired immediately after
 * usually loses the name to a corpse that is still being carried out. The
 * repo's own builder already knows this and polls until the name stops
 * resolving before rebuilding (assets/daytona/build.ts:26-38); this does the
 * same on a bounded budget rather than an open loop.
 *
 * FAILING TO DELETE IS NOT FATAL, which MATCHES upstream rather than diverging
 * from it: Harbor's _delete_snapshot logs the failure and carries on
 * (REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:213-224).
 * It suits this provider for its own reason too — a working direct image pull
 * still exists, so a refused delete leaves the behaviour that shipped before
 * this function, where throwing would turn a degraded path into a hard failure
 * for callers getting boxes today.
 *
 * The dead snapshot's errorReason is logged BEFORE the delete, because deleting
 * it destroys the only record of why the build died.
 */
async function deleteDeadSnapshot(
  client: {
    snapshot: {
      delete(snapshot: unknown): Promise<unknown>;
      get(name: string): Promise<{ state?: string } | undefined>;
    };
  },
  name: string,
  // errorReason is nullable on the real SDK type, absent on the wait's
  // structural one — accept both rather than making callers normalise it.
  snapshot: { state?: string; errorReason?: string | null },
  // Its OWN clock, not the conflict wait's — see snapshotDeleteTiming.
  timing?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  const reason = snapshot.errorReason ? `: ${snapshot.errorReason}` : "";
  console.warn(
    `[daytona] Deleting dead snapshot "${name}" (state "${snapshot.state ?? "unknown"}"${reason}) ` +
      "before rebuilding it."
  );
  try {
    await client.snapshot.delete(snapshot);
  } catch (err) {
    console.warn(
      `[daytona] Could not delete dead snapshot "${name}" (${err instanceof Error ? err.message : err}) — ` +
        "delete it in the Daytona dashboard (Snapshots page) to restore the fast path; " +
        "falling back to a direct image pull for now."
    );
    return false;
  }

  // Wait for the name to stop resolving. Only a NOT-FOUND means gone: a 403 or
  // a transient blip says nothing about whether the record survived, and
  // reading either as success would hand back a name still held by a corpse.
  // Same predicate the conflict wait uses, because it is the same question.
  const timeoutMs = timing?.timeoutMs ?? DAYTONA_SNAPSHOT_DELETE_TIMEOUT_MS;
  const pollMs = timing?.pollMs ?? DAYTONA_SNAPSHOT_DELETE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client.snapshot.get(name);
    } catch (err) {
      if (isMissingSnapshot(err instanceof Error ? err.message : String(err))) return true;
      // Anything else: keep looking until the budget runs out.
    }
    if (Date.now() >= deadline) {
      console.warn(
        `[daytona] Dead snapshot "${name}" still resolves ${timeoutMs}ms after it was deleted — ` +
          "leaving the rebuild to the next run rather than racing the removal."
      );
      return false;
    }
    await sleep(pollMs);
  }
}

/**
 * Does this snapshot-create failure mean "someone else already owns this
 * name"? Harbor decides the same question on the same evidence — lowercased
 * message contains "already exists" or "conflict"
 * (REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:281-283) —
 * and this adds the HTTP status the TS SDK carries on its error objects, which
 * the Python side does not surface as plainly.
 *
 * Kept to those signals on purpose: anything looser (a bare "409" anywhere in
 * the text, say) would classify an unrelated build failure as a race and make
 * this create wait ten minutes for a winner that does not exist.
 */
function isSnapshotNameConflict(err: unknown): boolean {
  if (httpStatusOf(err) === 409) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes("already exists") || message.includes("conflict");
}

/**
 * Is this poll failure an AUTH verdict rather than a blip? Rejected
 * credentials do not improve by being asked again, so they end the wait at
 * once instead of burning the whole budget on a question that can only be
 * answered the same way.
 */
function isAuthFailure(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status === 401 || status === 403) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("status code 401") ||
    message.includes("status code 403")
  );
}

/**
 * Wait for the winner of a snapshot name race to finish, and report which way
 * it went.
 *
 * WAIT-ON-CONFLICT, Harbor's law: when snapshot.create loses the name, the
 * image is already being built by the process that won it, so the right move
 * is to wait for that build and then use it — never to start a second, slower
 * copy of the same work. Harbor does exactly this at
 * REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:281-288
 * (conflict -> `_wait_for_active`), with the poll loop at :306-332.
 *
 * Four deliberate adaptations to this provider's idiom:
 *   - GET FIRST, then sleep. Harbor sleeps a full interval before its first
 *     look; most races here are lost to a build that finished seconds ago, and
 *     a wait that starts by looking costs nothing when the answer is already
 *     "active". Same loop shape as activateSnapshot() above.
 *   - A failed GET is not fatal, EXCEPT a not-found, which is an answer. The
 *     winner's snapshot can be briefly unreadable mid-build, so an ordinary
 *     poll error is logged and retried (Harbor warns and continues too,
 *     :326-327) — unlike the activation poll, where a failed GET IS the
 *     verdict. A 404 is different in kind: since this file gained a healer,
 *     the ordinary reason a contended name stops resolving is that another
 *     process cleared a corpse, so the FIRST not-found resolves the wait as
 *     DAYTONA_SNAPSHOT_GONE rather than counting toward the
 *     control-plane-is-down limit.
 *
 *     THE COST OF THAT CHOICE, ACCEPTED KNOWINGLY: a TRANSIENT 404 during a
 *     legitimate build ends the wait early, and the caller builds a name whose
 *     real owner still holds it — one doomed create, then the existing
 *     fallback. Self-correcting, and cheap. Requiring two consecutive 404s
 *     would remove it, at the price of an extra poll interval on what is now
 *     the COMMON case; the heal is meant to be fast, so the rare doomed create
 *     is the better trade.
 *   - WAIT ONLY ON A WHITELIST of in-flight states, where Harbor waits on
 *     everything that is not ACTIVE or ERROR (:316-323). Harbor's shape leaves
 *     `inactive`, `removing` and any future state polling for the whole budget
 *     to no purpose; here anything outside DAYTONA_SNAPSHOT_IN_FLIGHT_STATES
 *     is returned as an answer for the caller to route.
 *   - A DEAD WINNER IS RETURNED, NOT RAISED, where Harbor raises
 *     SandboxBuildFailedError (:321-323). Harbor's caller is wrapped in an
 *     outer retry that owns the recovery; this provider's caller owns it
 *     directly, and its recovery is the direct image pull — so the state has
 *     to come back as data. What IS raised here is the opposite case: a wait
 *     that could not be completed at all (budget exhausted, credentials
 *     refused, control plane silent), because none of those leave a sane
 *     fallback.
 *
 * Returns the resolving snapshot record: `active` means reuse it, `inactive`
 * means reuse it after reactivation, anything else means the winner's build is
 * not going to produce a snapshot and the caller may fall back.
 * Throws DaytonaSnapshotConflictError when the wait itself cannot finish.
 */
async function waitForSnapshotConflictWinner(
  client: SnapshotWaitClient,
  name: string,
  timing?: { timeoutMs?: number; pollMs?: number },
): Promise<{ state?: string } | typeof DAYTONA_SNAPSHOT_GONE> {
  const timeoutMs = timing?.timeoutMs ?? DAYTONA_SNAPSHOT_CONFLICT_TIMEOUT_MS;
  const pollMs = timing?.pollMs ?? DAYTONA_SNAPSHOT_CONFLICT_POLL_MS;

  console.log(
    `[daytona] Snapshot "${name}" is already being created by another process — waiting for it ` +
      `(up to ${Math.round(timeoutMs / 1000)}s) instead of pulling the image directly...`
  );

  const deadline = Date.now() + timeoutMs;
  let current: { state?: string } | undefined;
  let repeatedFailure = "";
  let repeats = 0;
  for (;;) {
    try {
      current = await client.snapshot.get(name);
      repeatedFailure = "";
      repeats = 0;
    } catch (err) {
      current = undefined;
      const failure = err instanceof Error ? err.message : String(err);

      // NOT-FOUND IS AN ANSWER, NOT A STRIKE. A healer clearing this dead name
      // is exactly what SHOULD happen, and counting its 404s toward the
      // control-plane-is-down limit would turn one process's repair into
      // another's hard failure.
      if (isMissingSnapshot(failure)) {
        console.log(
          `[daytona] Snapshot "${name}" no longer exists — the name is clear, building it.`
        );
        return DAYTONA_SNAPSHOT_GONE;
      }

      // Credentials that cannot read the snapshot cannot read it in nine more
      // minutes either. Ending here also keeps the failure legible: the
      // caller sees an auth problem, not a mysterious timeout.
      if (isAuthFailure(err)) {
        throw new DaytonaSnapshotConflictError(
          name,
          `the poll was refused (${failure}) — these credentials cannot read the snapshot, ` +
            "so waiting longer cannot help"
        );
      }

      // Otherwise expected while the winner builds: the record may be briefly
      // unreadable. Only a failure that REPEATS identically is treated as the
      // control plane being down rather than a blip.
      repeats = failure === repeatedFailure ? repeats + 1 : 1;
      repeatedFailure = failure;
      if (repeats >= DAYTONA_SNAPSHOT_POLL_FAILURE_LIMIT) {
        throw new DaytonaSnapshotConflictError(
          name,
          `${repeats} consecutive polls failed the same way (${failure}) — the control plane is ` +
            "not answering, so waiting longer cannot help"
        );
      }
      console.warn(`[daytona] Poll of contended snapshot "${name}" failed, retrying: ${failure}`);
    }

    // Anything that is not a build in flight resolves the wait. `active` and
    // `inactive` are both reusable (the caller reactivates the sleeping one);
    // `error`, `build_failed`, `removing` and any state Daytona adds later are
    // the end of the line, and the caller's fallback takes it from there.
    if (current !== undefined && !DAYTONA_SNAPSHOT_IN_FLIGHT_STATES.has(current.state ?? "")) {
      return current;
    }

    if (Date.now() >= deadline) {
      throw new DaytonaSnapshotConflictError(
        name,
        `it was still "${current?.state ?? "unknown"}" after ${timeoutMs}ms — retry once that ` +
          "build finishes, or check the snapshot in the Daytona dashboard (Snapshots page)"
      );
    }
    await sleep(pollMs);
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

/**
 * WHY EVERY COMMAND ANNOUNCES WHERE ITS OUTPUT ENDS.
 *
 * Daytona's session log is LINE-oriented: the daemon buffers each stream until
 * a newline and stores one record per line, `<3-byte marker><line>\n`.
 * MEASURED 2026-08-03 against a live sandbox (daytonaio/sandbox:0.8.0), the
 * same 25-byte marker printed with and without a trailing newline:
 *
 *   printf '%s' 'PM-PROBE-DAYTONA-BYTES-OK'  log: 01 01 01 <25 bytes> 0a
 *   echo 'PM-PROBE-DAYTONA-BYTES-OK'         log: 01 01 01 <25 bytes> 0a
 *
 * Byte-identical, though `wc -c` inside the box says 25 for the first and 26
 * for the second. So the log ADDS the terminator the first command never
 * printed, and no rule reading the log alone can tell an output that ended in
 * a newline from one the transport ended: keeping the byte corrupts `printf`,
 * stripping it corrupts `echo`. The chunked follow carries the same added
 * byte, so this is not the streaming path's doing.
 *
 * A command that marks its own end restores the difference. The shell prints a
 * per-run token after the command, with no newline of its own; the transport
 * then terminates whatever the last line turned out to be, and the token is
 * the only thing left to remove:
 *
 *   printf: `...OK` + token   -> record  `...OK<token>\n`        -> `...OK`
 *   echo:   `...OK\n` + token -> records `...OK\n` `<token>\n`   -> `...OK\n`
 *
 * One suffix removal serves both. A command that never reaches the token —
 * killed by the in-box timeout, or calling exit or exec itself — leaves none
 * to remove, and its output comes back exactly as it did before.
 *
 * STDOUT ONLY, and that is a choice. A token on stderr too would make stderr
 * byte-exact as well, but a daemon build that returns UNFRAMED logs (measured
 * — see readCommandStreams) hands both streams back as ONE, and the second
 * token then sits in the middle of that stream rather than at its end. Shedding
 * a token from the middle means deleting bytes a command may have printed
 * itself. With one token, printed last, the only place a sentinel can ever be
 * is the very end — so nothing in the middle of any stream is ever touched,
 * and stderr keeps the transport's terminator exactly as it did before.
 *
 * WHAT THIS STILL CANNOT TELL APART: a command whose stdout ENDS with this
 * run's own token. Only self-reference can do that (printing the wrapped
 * command back, tracing the final printf), the token is random per run, and
 * the cost is bounded to those bytes.
 */
function endOfOutputToken(): string {
  return `EVOLVE-EOS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * NOTHING IS APPENDED TO THE CALLER'S LAST LINE. The command goes inside a
 * brace group whose closing brace opens a line of its own, so what follows is
 * never read as a continuation of whatever the command ended with. Appending
 * `; ...` directly broke three shapes, all measured:
 *
 *   a command ending in a NEWLINE (every multi-line template literal) —
 *     `\n; __evolve_eos=$?` is a syntax error, exit 2
 *   a command ending in `&` — `& ;` is a syntax error and the command NEVER RAN
 *   a HEREDOC whose terminator is the command's last line — the appended text
 *     became part of the heredoc BODY: no error, exit 0, corrupt payload. That
 *     is the shape of the managed-secret proxy readiness probe (agent.ts), and
 *     it turned a healthy proxy into "failed to start".
 *
 * The group needs two guards of its own, both measured against /bin/sh,
 * /bin/bash and /bin/dash:
 *
 *   a leading `:` so the body is never EMPTY. A comment-only command
 *     (`# nothing`) otherwise leaves `{ # nothing\n}` — "syntax error near
 *     unexpected token `}'", exit 2, where the caller's own shell would have
 *     done nothing and exited 0. It runs BEFORE the command, so the status the
 *     group reports is still the command's own.
 *   a BLANK LINE before the closing brace, to be eaten by a command that ends
 *     in a dangling backslash. That backslash continues onto whatever line
 *     comes next; the blank line is what it consumes instead of the `}`, and
 *     `echo HI \` then runs as the caller's shell would run it — exit 0, "HI",
 *     with the exit code of a failing one (`false \` -> 1) still its own.
 *
 * WHAT STILL FAILS, LOUDLY: an UNTERMINATED heredoc (`cat <<'EOF'` with no
 * EOF line). Its body swallows everything that follows, including the closing
 * brace, so the command is a syntax error — exit 2, no output, the shell's own
 * message on stderr. No text can fix that from out here: anything added lands
 * inside the heredoc. A shell run of the same input without a wrapper prints
 * the body and exits 0, so this is the one shape the sentinel changes, and it
 * changes it to a loud failure rather than a quiet wrong answer.
 */
function withEndOfOutputSentinel(command: string, token: string): string {
  if (!command.trim()) return command;
  // `(exit $rc)` rather than `exit $rc`: an exit evaluated by the SESSION
  // shell ends the session, after which Daytona never records the command as
  // finished (see withInBoxTimeout). A subshell sets $? for the record without
  // touching the shell that has to keep reading.
  return (
    `{ :\n${command}\n\n}; __evolve_eos=$?; printf '%s' '${token}'; (exit $__evolve_eos)`
  );
}

/**
 * Shed the sentinel, and the terminator the transport put after it, from a
 * settled stream.
 *
 * ONLY AT THE END, because that is the only place the sentinel can be: it is
 * the last thing the command prints. A token anywhere else in the output is
 * the caller's own bytes — `ps` shows this very command line, and `sh -x`
 * traces the printf that writes it — and deleting those would be corruption,
 * silent and impossible to debug.
 */
function stripEndOfOutputSentinel(text: string, token: string): string {
  if (text.endsWith(`${token}\n`)) return text.slice(0, -(token.length + 1));
  if (text.endsWith(token)) return text.slice(0, -token.length);
  return text;
}

/**
 * A settled log read with the sentinel shed — from STDOUT only, because that is
 * the only stream the command prints one to. Shedding anything from stderr
 * could only ever delete bytes the command itself wrote (`sh -x` traces the
 * printf that writes the token, and that trace goes to stderr).
 */
function settledStreams(logs: unknown, token: string): { stdout: string; stderr: string } {
  const settled = readCommandStreams(logs as never);
  return {
    stdout: stripEndOfOutputSentinel(settled.stdout, token),
    stderr: settled.stderr,
  };
}

/**
 * Shed the sentinel from a stream still arriving, without holding back output
 * that is merely on its way.
 *
 * Same rule as the settled read — only the end of the stream can be the
 * sentinel — applied to bytes still coming: what could still GROW INTO it (the
 * longest tail that is a prefix of `<token>\n`) waits for the rest, and
 * everything else goes straight through, so a chunk that cannot be the start
 * of a sentinel is never delayed. Nothing mid-stream is ever dropped.
 */
function createSentinelFilter(token: string, emit: (chunk: string) => void) {
  const sentinel = `${token}\n`;
  let pending = "";

  const heldBack = (text: string): number => {
    for (let len = Math.min(text.length, sentinel.length); len > 0; len--) {
      if (sentinel.startsWith(text.slice(text.length - len))) return len;
    }
    return 0;
  };

  return {
    push(chunk: string) {
      pending += chunk;
      const keep = heldBack(pending);
      if (keep === pending.length) return;
      emit(pending.slice(0, pending.length - keep));
      pending = pending.slice(pending.length - keep);
    },
    /** The stream is over: what was held is the sentinel, or it was output after all. */
    flush() {
      const tail = pending === sentinel || pending === token ? "" : pending;
      pending = "";
      if (tail) emit(tail);
    },
  };
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
 * "started" → running; "stopped"/"archived"/"paused" → paused (our pause()
 * stops the sandbox; Daytona 0.203.0 added a native "paused" state for
 * pause-capable sandbox classes, and a box resting in it is paused by any
 * reading); transitional and terminal states match no filter.
 */
function daytonaStateToEvolveState(state?: string): "running" | "paused" | undefined {
  if (state === "started") return "running";
  if (state === "stopped" || state === "archived" || state === "paused") return "paused";
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
  /**
   * GPU reservation (count). Applied when a SNAPSHOT IS BUILT (Daytona
   * allocates GPU at snapshot build; GPU machines are tier-gated on Daytona's
   * side) — against an existing snapshot it throws DaytonaResourcesError like
   * every other pinned sizing field.
   */
  gpu?: number;
  /**
   * Acceptable GPU types (Daytona's GpuType names, e.g. "H100", "H200",
   * "RTX-PRO-6000"). Forwarded on the build path — Daytona validates the
   * names server-side — and refused on an existing snapshot alongside `gpu`.
   */
  gpuTypes?: string[];
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
  /**
   * Fetch units consumed: rows scanned from the cursor stream (before
   * filtering). Cursor pagination has no page numbers to count — and the modal
   * provider already reports item counts here — so "pages" reads as "units of
   * enumeration work", kept under this name because the field is shared
   * provider-neutral surface.
   */
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
 * SDK talks to DIRECTLY. Since 0.203.0 the runner base is not one discovery
 * call but DATA: every control-plane response DTO carries `toolboxProxyUrl`,
 * `processSandboxDto` re-derives the toolbox base `<toolboxProxyUrl>/<id>`
 * from it on EVERY refresh (esm/Sandbox.js:1303-1314), and
 * `sandboxApi.getToolboxProxyUrl(id)` is only the fallback for a DTO that
 * arrived without it (esm/Daytona.js:480-486). So pointing `apiUrl` at the
 * Evolve Dashboard captures create and list and nothing an agent does — and a
 * single overridden discovery method (the pre-0.203 seam) would be undone by
 * the first refreshData() that carried the real runner URL.
 *
 * Managed mode therefore wraps the ONE object every DTO flows through: the
 * client's `sandboxApi`. The wrap answers getToolboxProxyUrl locally with the
 * Dashboard's toolbox route and rewrites `toolboxProxyUrl` to that same route
 * in every response DTO, so the client builds
 * `<dashboard>/api/managed/daytona/toolbox/<sandboxId>/…` for exactly the
 * paths it would otherwise have sent to Daytona's runner — a runner the
 * managed caller has no credential for (the account key that opens it lives
 * gateway-side and never reaches an SDK process; the Dashboard resolves the
 * host itself, per sandbox, and forwards with a per-sandbox token). No path
 * is rewritten: the base URL is the only thing that moves.
 */

/** The DTO-bearing responses the managed wrap rewrites. */
function rewriteToolboxProxyUrls(payload: unknown, managedToolboxUrl: string): void {
  if (!payload || typeof payload !== "object") return;
  const record = payload as { toolboxProxyUrl?: unknown; items?: unknown };
  // Only a DTO that CARRIES the field is rewritten: processSandboxDto ignores
  // an absent one and the wrapped getToolboxProxyUrl covers that path locally.
  if (typeof record.toolboxProxyUrl === "string") {
    record.toolboxProxyUrl = managedToolboxUrl;
  }
  if (Array.isArray(record.items)) {
    for (const item of record.items) rewriteToolboxProxyUrls(item, managedToolboxUrl);
  }
}

/**
 * Wrap the SDK's sandbox api-client so no response can point the toolbox at
 * Daytona's runner. Generic over the method set on purpose: the api client is
 * generated code that grows methods every release, and the invariant is about
 * the DATA (any DTO carrying toolboxProxyUrl), not about which call returned
 * it.
 */
function wrapManagedSandboxApi<T extends object>(api: T, managedToolboxUrl: string): T {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "getToolboxProxyUrl") {
        // Answered locally, never upstream: the managed door does not serve
        // runner discovery, and the Dashboard route is the same for every box.
        return async () => ({ data: { url: managedToolboxUrl } });
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return function (this: unknown, ...args: unknown[]) {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          return result.then((response) => {
            rewriteToolboxProxyUrls((response as { data?: unknown } | undefined)?.data, managedToolboxUrl);
            return response;
          });
        }
        return result;
      };
    },
  });
}

class ManagedDaytona extends Daytona {
  constructor(
    config: ConstructorParameters<typeof Daytona>[0],
    managedToolboxUrl: string,
  ) {
    super(config);
    // `sandboxApi` is TypeScript-private but a plain runtime property, and it
    // is the single instance shared with every Sandbox the client hands out —
    // so wrapping it here covers create, get, list, refreshData and fork alike.
    const self = this as unknown as { sandboxApi: object };
    self.sandboxApi = wrapManagedSandboxApi(self.sandboxApi, managedToolboxUrl);
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
  signal?: AbortSignal,
): Promise<void> {
  const url =
    `${context.toolboxUrl.replace(/\/+$/, "")}/${encodeURIComponent(sandboxId)}` +
    `/process/session/${encodeURIComponent(sessionId)}` +
    `/command/${encodeURIComponent(commandId)}/logs?follow=true`;

  // The signal is what lets a caller stop reading a body nothing will ever
  // end: a chunked follow has no close from this side, and a pending
  // reader.read() holds the event loop open for as long as the socket does.
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      accept: "application/octet-stream",
    },
    ...(signal ? { signal } : {}),
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
  /** The streamed-run clocks, shrinkable by a subclass so a test need not wait them out. */
  protected streamTimings: DaytonaStreamTimings = DAYTONA_STREAM_TIMINGS;

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
   *
   * Only the managed follow takes the abandon signal — the SDK's websocket
   * follow exposes none, so a direct-mode stall is stopped from waiting on
   * but not closed; the ephemeral session's delete is what ends it.
   */
  private followLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.managedStream) {
      return followManagedSessionLogs(
        this.managedStream,
        this.sandbox.id,
        sessionId,
        commandId,
        onStdout,
        onStderr,
        signal,
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
      // What the box prints to say its output ended, so the log's line
      // terminator can be told from the command's own last byte (see
      // withEndOfOutputSentinel).
      const eosToken = endOfOutputToken();
      // The third argument stays the wait bound of a blocking execute, and
      // withInBoxTimeout is what survives this process dying while it waits
      // (see the wrapper's header). Both are the caller's own timeout, so
      // whichever fires first, nothing outlives it.
      const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
        command: withInBoxTimeout(
          wrapCommand(
            withEndOfOutputSentinel(command, eosToken),
            options?.cwd,
            options?.envs,
            this.user
          ),
          timeoutSec
        ),
        runAsync: streaming,
      }, timeoutSec);

      const cmdId = resp.cmdId;

      // An async execute with no command id is unfollowable: there is nothing
      // to stream and no place the exit code will ever appear. Falling through
      // to the blocking tail would report `resp.exitCode ?? 0` — a fabricated
      // success for a command still running. Refuse instead.
      if (streaming && !cmdId) {
        throw new Error("Daytona returned no command id for an async command — cannot stream it or read its exit code");
      }

      if (streaming && cmdId) {
        // The streamed chunks ARE the result: they reach the callbacks live
        // and accumulate into the returned stdout/stderr. The follow runs
        // ALONGSIDE the exit poll rather than before it (awaitStreamedExit
        // states why), and `live` is what keeps a follow abandoned mid-chunk
        // from delivering into a result the caller already has.
        let stdout = "";
        let stderr = "";
        let live = true;
        let lastChunkAt = Date.now();
        // The sentinel is filtered out of what the caller sees and what the
        // run returns; a held-back byte is still a byte that arrived, so the
        // silence clock is stamped before the filter, not after it. STDOUT
        // only — stderr carries no sentinel and so passes through untouched.
        const stdoutFilter = createSentinelFilter(eosToken, (chunk) => {
          stdout += chunk;
          options?.onStdout?.(chunk);
        });
        const abandon = new AbortController();
        const follow = this.followLogs(
          sessionId,
          cmdId,
          (chunk) => {
            if (!live) return;
            lastChunkAt = Date.now();
            stdoutFilter.push(chunk);
          },
          (chunk) => {
            if (!live) return;
            lastChunkAt = Date.now();
            stderr += chunk;
            options?.onStderr?.(chunk);
          },
          abandon.signal,
        );
        // A follow that DIED (before this side abandoned it) delivered only a
        // prefix of the run's output; the settled-log reconcile below is what
        // makes the run whole again. The abandon itself is not a death.
        let abandoned = false;
        let followFailure: unknown;
        const followSettled = follow.then(
          () => undefined,
          (error) => {
            if (!abandoned) followFailure = error;
          },
        );
        let exitCode: number;
        try {
          exitCode = await this.awaitStreamedExit(
            sessionId,
            cmdId,
            follow,
            () => lastChunkAt,
            options?.timeoutMs
          );
        } finally {
          abandoned = true;
          abandon.abort();
          // THE FOLLOW MUST SETTLE BEFORE `live` DROPS. The demuxer always
          // holds back the last MAX_PREFIX_LEN-1 bytes against a marker split
          // across chunks, and emits them only in its flush — which runs as
          // the follow winds down. Cutting `live` first discarded that flush,
          // so every run whose follow outlived its command (the chunked
          // follow's normal state) lost the final bytes of its output —
          // measured as a marker ending "-OK" coming back "-O", exit 0.
          // Bounded, because the direct-mode websocket takes no abort signal
          // and a stalled one must not hold the result hostage.
          await Promise.race([followSettled, sleep(this.streamTimings.drainMs)]);
          live = false;
          // Nothing more will arrive, so what the filters still hold is either
          // the sentinel (shed) or the run's last bytes (delivered). A follow
          // that DIED is the exception: a socket cut mid-sentinel leaves a
          // token fragment held, and a fragment is exactly what cannot be told
          // from output without the rest of it. The settled log below knows,
          // so the held bytes are dropped here and come back from there.
          if (followFailure === undefined) stdoutFilter.flush();
        }
        if (followFailure !== undefined) {
          // The follow socket died mid-stream. The settled log is the whole
          // record, so when what streamed is a prefix of it the missing
          // suffix is appended and emitted — never re-emitting what the
          // caller already saw. If the settled log cannot be read or does not
          // extend what streamed, the broken stream is the story: throwing it
          // beats silently returning truncated output as a success.
          let settled: { stdout: string; stderr: string };
          try {
            const logs = await this.sandbox.process.getSessionCommandLogs(sessionId, cmdId);
            settled = settledStreams(logs, eosToken);
          } catch {
            throw followFailure;
          }
          if (!settled.stdout.startsWith(stdout) || !settled.stderr.startsWith(stderr)) {
            throw followFailure;
          }
          const stdoutTail = settled.stdout.slice(stdout.length);
          const stderrTail = settled.stderr.slice(stderr.length);
          stdout = settled.stdout;
          stderr = settled.stderr;
          if (stdoutTail) options?.onStdout?.(stdoutTail);
          if (stderrTail) options?.onStderr?.(stderrTail);
        } else if (!stdout && !stderr) {
          // Nothing arrived on the follow. A command that finished before the
          // stream connected is indistinguishable from one that printed
          // nothing, and nothing documents the follow endpoint as replaying
          // what it already buffered — so read the settled log the way the
          // blocking path does rather than report a silent run. Both streams
          // must be empty to take it: a partial follow already reached the
          // callbacks and re-emitting would double the caller's output.
          try {
            const logs = await this.sandbox.process.getSessionCommandLogs(sessionId, cmdId);
            const settled = settledStreams(logs, eosToken);
            stdout = settled.stdout;
            stderr = settled.stderr;
            if (stdout) options?.onStdout?.(stdout);
            if (stderr) options?.onStderr?.(stderr);
          } catch {
            // Ignore log fetch errors — the exit code is still the truth.
          }
        }
        return { exitCode, stdout, stderr };
      }

      // Only the blocking path reaches here — a streaming caller with a cmdId
      // already returned above. Try inline output first; if empty and we have
      // cmdId, fetch logs explicitly.
      let { stdout, stderr } = settledStreams(resp, eosToken);
      if (!stdout && !stderr && cmdId) {
        try {
          const logs = await this.sandbox.process.getSessionCommandLogs(sessionId, cmdId);
          const fromLogs = settledStreams(logs, eosToken);
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

  /**
   * WHAT SAYS A STREAMED RUN IS OVER: the command's record, never the follow.
   *
   * A chunked follow can stall open long after its command exited — nothing
   * acks a response body — and awaiting it first, then polling for an exit
   * code 20 times at 500ms, gave a streaming run() two failure modes the
   * blocking path never had: a stalled socket hung run() forever (with no
   * timeoutMs, nothing in the box or out of it bounds the wait), and a follow
   * that closed a moment early threw "no exit code" on a command that had
   * already succeeded.
   *
   * So the poll and the follow run TOGETHER. The poll decides when the run
   * ended; the follow then gets as long as it keeps delivering and is cut
   * only once it has been SILENT for the drain window, so a live stream is
   * never truncated and a dead one is never waited on. Two ceilings bound the
   * wait: the caller's timeoutMs widened by the in-box kill grace, and — for
   * the caller who passed none — the settle bound measured from the moment
   * the follow closed, because a closed stream means the command ended and a
   * record that never catches up is a provider incident, not a long run.
   * A run with no timeoutMs whose command is genuinely still streaming is
   * still waited on indefinitely: that is what asking for no bound means.
   */
  private async awaitStreamedExit(
    sessionId: string,
    cmdId: string,
    follow: Promise<void>,
    lastChunkAt: () => number,
    timeoutMs?: number,
  ): Promise<number> {
    const clocks = this.streamTimings;
    let followClosedAt: number | undefined;
    let followError: unknown;
    const followSettled = follow.then(
      () => {
        followClosedAt = Date.now();
      },
      (error) => {
        followClosedAt = Date.now();
        followError = error;
      },
    );
    const hardDeadline =
      timeoutMs !== undefined && timeoutMs > 0
        ? Date.now() + timeoutMs + clocks.killGraceMs
        : undefined;
    let pollMs = clocks.pollMinMs;
    for (;;) {
      // A follow that FAILED no longer aborts the wait: the command's record
      // still decides, and run() recovers what the broken stream withheld
      // from the settled log. The failure is kept so a record that never
      // settles is reported by its real cause rather than a bare deadline.
      const cmd = await this.sandbox.process.getSessionCommand(sessionId, cmdId);
      // The wire says "still running" with a NULL exit code, not an absent
      // one — `!== undefined` handed that null back as this run's status.
      if (cmd.exitCode !== undefined && cmd.exitCode !== null) {
        for (;;) {
          if (followClosedAt !== undefined) break;
          const idleMs = Date.now() - lastChunkAt();
          if (idleMs >= clocks.drainMs) break;
          await Promise.race([followSettled, sleep(clocks.drainMs - idleMs)]);
        }
        return cmd.exitCode;
      }
      const settleDeadline =
        followClosedAt !== undefined ? followClosedAt + clocks.settleMs : undefined;
      const deadline =
        hardDeadline !== undefined && settleDeadline !== undefined
          ? Math.min(hardDeadline, settleDeadline)
          : (hardDeadline ?? settleDeadline);
      if (deadline !== undefined && Date.now() >= deadline) {
        if (followError !== undefined) throw followError;
        throw new Error(
          `Daytona reported no exit code for command ${cmdId} after ` +
            (followClosedAt !== undefined
              ? "its log stream closed"
              : `${timeoutMs}ms`)
        );
      }
      await sleep(pollMs);
      pollMs = Math.min(pollMs * 2, clocks.pollMaxMs);
    }
  }

    async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    const sessionId = `evolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.sandbox.process.createSession(sessionId);

    const timeoutSec = options?.timeoutMs ? Math.floor(options.timeoutMs / 1000) : undefined;
    const startedAt = Date.now();
    const timeoutMs = options?.timeoutMs;

    const eosToken = endOfOutputToken();
    const resp = await this.sandbox.process.executeSessionCommand(sessionId, {
      command: withInBoxTimeout(
        wrapCommand(
          withEndOfOutputSentinel(command, eosToken),
          options?.cwd,
          options?.envs,
          this.user
        ),
        timeoutSec
      ),
      runAsync: true,
    }, timeoutSec);

    const cmdId = resp.cmdId;

    if (cmdId && (options?.onStdout || options?.onStderr)) {
      const stdoutFilter = createSentinelFilter(eosToken, options.onStdout || (() => {}));
      this.followLogs(
        sessionId,
        cmdId,
        (chunk) => stdoutFilter.push(chunk),
        options.onStderr || (() => {})
      ).catch(() => {
        // Ignore streaming errors for background processes
      }).finally(() => stdoutFilter.flush());
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
                  ...settledStreams(logs, eosToken),
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
          await sleep(500);
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

  /**
   * Clocks of the WAIT-ON-CONFLICT path (see waitForSnapshotConflictWinner).
   * A field rather than a constant so tests can drive the shape of the wait
   * without spending its production budget, the same way streamTimings does.
   */
  protected snapshotConflictTiming: { timeoutMs: number; pollMs: number } = {
    timeoutMs: DAYTONA_SNAPSHOT_CONFLICT_TIMEOUT_MS,
    pollMs: DAYTONA_SNAPSHOT_CONFLICT_POLL_MS,
  };

  /**
   * Clocks of the DELETE-CONFIRMATION poll (see deleteDeadSnapshot). Separate
   * from snapshotConflictTiming because the two wait for different things on
   * different scales: the conflict clock waits out another process's IMAGE
   * BUILD, which legitimately takes minutes, while this one waits for a record
   * to stop resolving after Daytona acknowledged its deletion — seconds of
   * bookkeeping. Handing the delete poll the conflict budget let the fast path
   * block for ten minutes on a lingering corpse and left this function's own
   * constants unreachable.
   */
  protected snapshotDeleteTiming: { timeoutMs: number; pollMs: number } = {
    timeoutMs: DAYTONA_SNAPSHOT_DELETE_TIMEOUT_MS,
    pollMs: DAYTONA_SNAPSHOT_DELETE_POLL_MS,
  };

  constructor(config: ResolvedDaytonaConfig) {
    const clientConfig = {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      target: config.target,
      // Since 0.203.0 the client otherwise opens a socket.io WebSocket to the
      // API at CONSTRUCTION for event streaming. Polling keeps the wire
      // behavior this provider has always had — and a managed caller's apiUrl
      // is a Dashboard route handler, which can never terminate that socket.
      useDeprecatedPolling: true,
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
    // GPU TYPE counts as sizing since @daytonaio/sdk 0.203.0 grew a real
    // `Resources.gpuType` field: on a BUILD it is forwarded (Daytona validates
    // the type names server-side), and against an existing snapshot it is as
    // pinned as every other resource.
    const wantsResources =
      options.resources !== undefined &&
      (options.resources.cpu !== undefined ||
        options.resources.memory !== undefined ||
        options.resources.disk !== undefined ||
        options.resources.gpu !== undefined ||
        options.resources.gpuTypes !== undefined);

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

    // Set when the fast-path GET found a build ALREADY IN FLIGHT for this name
    // (see DAYTONA_SNAPSHOT_IN_FLIGHT_STATES). The build path below reads it to
    // skip a snapshot.create that can only lose, exactly as Harbor's resolve
    // sends a PENDING snapshot straight to its wait
    // (REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:193-198).
    let inFlightState: string | undefined;

    // Set when a dead snapshot was found and its removal could NOT be
    // confirmed. The build path refuses to race a removal still in progress.
    let deadNameCleared: boolean | undefined;

    // Try to use existing snapshot first (fast path for returning users or ./build.sh daytona)
    try {
      const snapshot = await this.client.snapshot.get(imageName);
      let snapshotState: string | undefined = snapshot?.state;
      if (snapshot && DAYTONA_SNAPSHOT_IN_FLIGHT_STATES.has(snapshotState ?? "")) {
        inFlightState = snapshotState;
      }
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
      // A DEAD snapshot is cleared right here, because the name is the whole
      // problem: nothing below can build over it, so every later run of this
      // image degraded to the slow direct pull, permanently. Harbor deletes and
      // rebuilds for the same reason (snapshots.py:200-212); the rebuild is the
      // build path below, which this fall-through reaches with the name free.
      //
      // TWO OF THE THREE WAYS TO MEET A CORPSE ARE HEALED IN THIS PASS: found
      // dead here, and found dead by the conflict wait below. The third is a
      // snapshot that dies DURING reactivation — activateSnapshot's own poll
      // sees the dead state and raises its typed refusal, which is a final
      // verdict rather than a build trigger, so no delete happens on that run.
      // It is left that way on purpose: the refusal is what tells the caller
      // their box is not coming, and the corpse it leaves is cleared by
      // whichever caller arrives next, through this very branch.
      //
      // DECLARED SIZING AND A DEAD SNAPSHOT: FIRST BUILDER WINS. The sizing
      // refusal above deliberately does not fire here — it guards an existing
      // snapshot whose resources are already pinned, and a dead one pins
      // nothing. So a caller declaring resources rebuilds the name at THEIR
      // sizing, and every later caller inherits it until the snapshot dies
      // again. That is the same first-builder-wins wart the whole
      // content-address-free naming scheme has (a name is one image, not one
      // image per sizing); it is recorded rather than fixed because fixing it
      // means content-addressing the name, which is the eval platform's
      // approach one floor up, not this provider's.
      if (snapshot && DAYTONA_SNAPSHOT_DEAD_STATES.has(snapshotState ?? "")) {
        if (providerCanRebuildSnapshot(imageName)) {
          // The build below is skipped unless the name is CONFIRMED clear, the
          // same rule the join path follows: a create over a corpse that is
          // still there loses the name and buys a wasted round trip.
          deadNameCleared = await deleteDeadSnapshot(
            this.client,
            imageName,
            snapshot,
            this.snapshotDeleteTiming
          );
        } else {
          console.warn(
            `[daytona] Snapshot "${imageName}" is dead (state "${snapshotState}") but this provider ` +
              "cannot rebuild that name — delete it in the Daytona dashboard (Snapshots page), or " +
              "rebuild it with the tooling that created it."
          );
        }
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

      // A build already in flight for this name is JOINED, not raced. Calling
      // snapshot.create here can only lose — and losing is the good case: an
      // answer that is not a 409 (a 200 that quietly attaches to the running
      // build) leaves the SDK polling that build with no budget of ours at all.
      // Declared sizing is the exception: the in-flight build will pin
      // resources this caller did not ask for, so there is nothing to join and
      // the direct pull below (which does take the caller's sizing) is right.
      const joinInFlightBuild = inFlightState !== undefined && !wantsResources;

      if (joinInFlightBuild) {
        console.log(
          `[daytona] Snapshot "${imageName}" is mid-build (state "${inFlightState}") — joining that ` +
            "build rather than starting a second one."
        );
      } else if (inFlightState !== undefined) {
        console.log(
          `[daytona] Snapshot "${imageName}" is mid-build (state "${inFlightState}") and cannot carry ` +
            `the requested sizing — pulling image directly instead: ${publicImage}`
        );
      } else {
        console.log(`[daytona] Snapshot "${imageName}" not found, building from image: ${publicImage}`);
        console.log("[daytona] First run will take a few minutes (this only happens once)...");
      }

      try {
        if (deadNameCleared === false) {
          throw new Error(
            `dead snapshot "${imageName}" was not confirmed removed — not racing its removal`
          );
        }
        // Step 1: Create named snapshot (blocking — so it's available for all future runs)
        // Use Image.base() — snapshot.create() requires a Daytona Image object, not a raw string
        // The build, as a closure: the two routes that discover a DEAD name mid
        // flight both have to run it after clearing that name, and Harbor's
        // _SnapshotNeedsCreate sends its caller back to exactly this step.
        const buildSnapshot = () =>
          this.client.snapshot.create(
              {
                name: imageName,
                image: Image.base(publicImage),
                resources: {
                  cpu: options.resources?.cpu ?? 4,
                  memory: options.resources?.memory ?? 4,
                  disk: options.resources?.disk ?? 10,
                  // GPU count, when requested: Daytona allocates GPU at snapshot
                  // build. Tier-gated on Daytona's side — an account without GPU
                  // quota gets Daytona's own loud refusal here, never a silent CPU
                  // snapshot.
                  ...((options.resources?.gpu ?? 0) > 0
                    ? { gpu: options.resources!.gpu! }
                    : {}),
                  // GPU TYPE, when constrained: a real wire field since 0.203.0
                  // (Resources.gpuType, e.g. "H100"). Passed through as given —
                  // Daytona rejects names outside its GpuType enum loudly, which
                  // beats this provider maintaining a shadow copy of their list.
                  ...(options.resources?.gpuTypes?.length
                    ? { gpuType: options.resources.gpuTypes as GpuType[] }
                    : {}),
                },
              },
              { onLogs: (log: string) => console.log(`[daytona] ${log}`) },
            );

        // A join that reports NEEDS-CREATE found the name dead and cleared it,
        // so the build it was waiting for has to be run here. Harbor routes the
        // same discovery the same way, with _SnapshotNeedsCreate sending its
        // caller back to create (snapshots.py:200-212).
        const buildAfterClearedName = async (): Promise<void> => {
          await buildSnapshot();
          console.log(`[daytona] Snapshot "${imageName}" ready (rebuilt here after a dead build).`);
        };

        if (inFlightState !== undefined) {
          if (!joinInFlightBuild) {
            throw new Error(
              `snapshot "${imageName}" is mid-build (state "${inFlightState}") and cannot be resized`
            );
          }
          if (await this.joinInFlightSnapshotBuild(imageName)) await buildAfterClearedName();
        } else {
          try {
            await buildSnapshot();
            console.log(`[daytona] Snapshot "${imageName}" ready (built here).`);
          } catch (createErr) {
            // WAIT-ON-CONFLICT. Losing the name means another process is ALREADY
            // building this exact image, so the cheap move is to wait for it and
            // then use it as a cache hit. The old code fell straight through to
            // the direct image pull below, which pulls the same bytes a second
            // time on the slow path — the 2026-07-31 evolve-all prod incident,
            // whose other half (exists-but-inactive) is healed in the fast path
            // above. Harbor rules this the same way:
            // REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:281-288.
            if (!isSnapshotNameConflict(createErr)) throw createErr;

            // Declared sizing does not survive a lost race either, and the
            // caller's sizing is what matters: the winner's snapshot pins its
            // own resources, so joining it would hand back a box that quietly
            // ignores the request. The direct pull below honours the request,
            // and it is what this case has always done.
            if (wantsResources) throw createErr;

            if (await this.joinInFlightSnapshotBuild(imageName)) await buildAfterClearedName();
          }
        }

        // Step 2: Create sandbox from the just-created snapshot (fast)
        sandbox = await this.client.create(
          {
            snapshot: imageName,
            ...baseParams,
          },
          { timeout: 600 }
        );
      } catch (snapshotErr) {
        // Two final verdicts, for the same reason the fast path honours its
        // own: a race this run could not wait out, and a snapshot that exists
        // but will not activate, are both answers — not reasons to pull the
        // image the slow way and call it a success.
        if (snapshotErr instanceof DaytonaSnapshotConflictError) throw snapshotErr;
        if (snapshotErr instanceof DaytonaSnapshotActivationError) throw snapshotErr;
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
                // The same GPU knobs the snapshot build would have honored:
                // a fallback that silently downgraded "an H100 box" to a CPU
                // box would be this file's own provider law broken in-house.
                ...((options.resources?.gpu ?? 0) > 0 ? { gpu: options.resources!.gpu! } : {}),
                ...(options.resources?.gpuTypes?.length
                  ? { gpuType: options.resources.gpuTypes as GpuType[] }
                  : {}),
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

  /**
   * Join a snapshot build another process is already running, and leave the
   * name usable — or say why it is not.
   *
   * Returns FALSE when the snapshot can be used by name as it stands, and TRUE
   * when the name was found dead, deleted, and now needs building: the caller
   * runs the build it was waiting for. That is Harbor's _SnapshotNeedsCreate
   * signal, which its resolve raises after deleting an ERROR-state snapshot
   * (REFERENCES/Harbor/src/harbor/environments/daytona/snapshots.py:200-212).
   *
   * DELIBERATELY STRICTER THAN UPSTREAM ON ONE POINT. Harbor raises
   * _SnapshotNeedsCreate whether or not its delete succeeded — _delete_snapshot
   * logs a failure and returns, and the caller creates regardless (:213-224).
   * This returns NEEDS-CREATE only when the name is CONFIRMED clear. A create
   * fired over a corpse that is still there loses the name and lands back in
   * the conflict wait, which is a slower way of reaching the same fallback with
   * one wasted round trip; when the name is genuinely gone, the create is the
   * whole point. Swallowing a FAILED delete, by contrast, is not a divergence
   * at all — that matches Harbor exactly.
   *
   * Throws a plain Error when the in-flight build produced nothing usable AND
   * the name could not be cleared, which is the ONE case create()'s direct
   * image pull is still right: nobody is going to produce this snapshot, so
   * waiting longer buys nothing. The typed errors (conflict, activation) pass
   * straight through create()'s fallback as final verdicts.
   */
  private async joinInFlightSnapshotBuild(imageName: string): Promise<boolean> {
    const winner = await waitForSnapshotConflictWinner(
      this.client,
      imageName,
      this.snapshotConflictTiming,
    );

    // The name was cleared while we waited (a healer, here or in another
    // process). Nothing to join and nothing to reuse — build it.
    if (winner === DAYTONA_SNAPSHOT_GONE) return true;

    if (winner.state === "active") {
      console.log(`[daytona] Snapshot "${imageName}" ready (built by another process) — reusing it.`);
      return false;
    }

    // Won the race, then slept: Daytona deactivates a snapshot unused for two
    // weeks, and a build that finished long before this call can be found
    // already inactive. Exists-but-inactive is HEALED here for the same reason
    // it is healed in the fast path — reactivation is a pull, not a rebuild —
    // and a reactivation that fails is a typed final verdict, not a fallback.
    if (winner.state === "inactive") {
      await activateSnapshot(this.client, imageName, winner);
      console.log(`[daytona] Snapshot "${imageName}" ready (built by another process) — reusing it.`);
      return false;
    }

    // THE BUILD WE WAITED FOR DIED, and it left its corpse holding the name.
    // Falling straight to the direct pull (what this did before) meant every
    // later run pulled the same bytes the slow way forever, because nothing
    // ever removed the failed record. Clear it and tell the caller to build.
    if (
      DAYTONA_SNAPSHOT_DEAD_STATES.has(winner.state ?? "") &&
      providerCanRebuildSnapshot(imageName) &&
      (await deleteDeadSnapshot(this.client, imageName, winner, this.snapshotDeleteTiming))
    ) {
      return true;
    }

    throw new Error(
      `the in-flight build of snapshot "${imageName}" ended in state "${winner.state ?? "unknown"}"`
    );
  }

  async connect(sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
    const sandbox = await this.client.get(sandboxId);
    if (sandbox.state !== "started") {
      await sandbox.start();
    }
    return new DaytonaSandboxImpl(sandbox, this.sandboxUsers.get(sandboxId), this.managedStream);
  }

  /**
   * List sandboxes, walking the cursor stream to exhaustion.
   *
   * An early version requested page 1 and stopped, discarding the rest — an
   * organization with more than one page of sandboxes was silently truncated,
   * and nothing in the return value said so. For any caller that reads absence
   * from the list as "this sandbox is gone", that is a correctness bug. Cursor
   * pagination (mandatory since Daytona retired page numbers on 2026-06-25)
   * changes the mechanics, not the law: the walk still runs to the end or says
   * it could not.
   *
   * ORDER OF OPERATIONS, because it is observable: `limit` bounds the
   * sandboxes RETURNED, and the state filter runs client-side on every row
   * BEFORE the limit is counted. Asking for 10 running sandboxes therefore
   * keeps walking until ten running ones have been found, rather than
   * filtering ten arbitrary rows down to whatever survives.
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
    return collectSandboxStream(this.listStream(options), options);
  }

  /**
   * The cursor stream, asking the API to narrow server-side where it can.
   *
   * Since 0.203.0 the SDK's public `list(query)` takes `states` and `labels`
   * directly and pages by cursor internally (items + nextCursor,
   * esm/Daytona.js:430-476), so the old reach-around through the private
   * `sandboxApi.listSandboxesPaginated` field is gone along with the method
   * itself. The client-side filter in the walk stays the authority regardless:
   * a server filter that silently stopped applying must never be able to admit
   * a state the caller excluded.
   */
  private listStream(options?: SandboxListOptions): AsyncIterable<DaytonaSandbox> {
    const states = options?.state ? evolveStatesToDaytonaStates(options.state) : undefined;
    const query: ListSandboxesQuery = {
      // Per-FETCH size, not a total bound — the iterator keeps following
      // nextCursor until the fleet runs out.
      limit: DAYTONA_LIST_PAGE_SIZE,
      ...(options?.metadata ? { labels: options.metadata } : {}),
      ...(states && states.length > 0 ? { states: states as DaytonaApiSandboxState[] } : {}),
    };
    return this.client.list(query);
  }
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
    if (state === "paused") out.push("stopped", "archived", "paused");
  }
  return out;
}

/**
 * Walk the cursor stream into one answer, with an honest completeness verdict.
 *
 * Separate from the provider because everything worth getting wrong lives here
 * and none of it needs a network: the ways a walk can fail to terminate, the
 * difference between "the caller asked for ten" and "the provider ran out",
 * and the rule that a failure mid-walk yields the sandboxes seen so far marked
 * INCOMPLETE rather than either an exception or a short complete list.
 *
 * WHAT CURSORS CHANGED HERE, and what they did not. The vendor's iterator ends
 * itself when nextCursor runs out, so "exhausted" is now the stream ending
 * rather than a totalPages comparison; a fetch failure mid-walk surfaces as
 * the iterator throwing. The LAWS are unchanged: a walk that could not finish
 * reports `complete: false` with what it saw, a caller's limit is reported as
 * truncation whenever one more row provably exists (the row after the limit is
 * that proof — the walk holds it, so no extra fetch is spent on it beyond, at
 * worst, the one the iterator was already making), and a runaway fleet stops
 * at the scan ceiling as a refusal, never as a short list that reads complete.
 *
 * Exported for its test (`_testCollectSandboxStream`).
 */
async function collectSandboxStream(
  stream: AsyncIterable<DaytonaSandboxLike & { state?: string }>,
  options?: SandboxListOptions,
): Promise<SandboxListPage & { stoppedAtLimit: boolean }> {
  const wanted = options?.limit;
  const sandboxes: SandboxInfo[] = [];
  /** Rows consumed from the stream — what `pagesFetched` reports (fetch units). */
  let scanned = 0;
  /**
   * Consistency across a mutating fleet is cursor pagination's own promise,
   * but it is the VENDOR's promise: a fleet enumeration that reported the same
   * sandbox twice would make every count downstream wrong, so ids are still
   * deduped as they arrive. Costs nothing when the promise holds.
   */
  const seenIds = new Set<string>();

  try {
    for await (const sandbox of stream) {
      // TRUNCATION EVIDENCE FIRST: any row arriving after the limit is filled
      // proves the enumeration is holding something back. Checked before the
      // state filter on purpose — the old page walk called ANY remaining page
      // truncation, and a cheaper answer that scans on to prove the filtered
      // remainder empty would spend unbounded requests to upgrade
      // "incomplete" to "complete" for a caller who asked for a sample.
      if (wanted !== undefined && sandboxes.length >= wanted) {
        return {
          sandboxes,
          complete: false,
          pagesFetched: scanned,
          stoppedAtLimit: true,
          error: `stopped at the requested limit of ${wanted} with more sandboxes available`,
        };
      }
      scanned += 1;
      if (scanned > DAYTONA_MAX_LIST_SCAN) {
        return {
          sandboxes,
          complete: false,
          pagesFetched: DAYTONA_MAX_LIST_SCAN,
          stoppedAtLimit: false,
          error: `sandbox list exceeded ${DAYTONA_MAX_LIST_SCAN} sandboxes scanned`,
        };
      }
      if (options?.state) {
        // The state filter runs client-side on the REAL API-reported state,
        // and it stays the authority even when the server was asked to narrow
        // too: a server filter that silently stopped applying must never be
        // able to admit a state the caller excluded. It runs BEFORE the limit
        // is counted, so "ten running" means ten running rather than ten rows
        // minus misses.
        const evolveState = daytonaStateToEvolveState(sandbox.state);
        if (evolveState === undefined || !options.state.includes(evolveState)) continue;
      }
      if (seenIds.has(sandbox.id)) continue;
      seenIds.add(sandbox.id);
      sandboxes.push(toSandboxInfo(sandbox));
    }
  } catch (err) {
    return {
      sandboxes,
      complete: false,
      pagesFetched: scanned,
      stoppedAtLimit: false,
      error: `sandbox list failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { sandboxes, complete: true, pagesFetched: scanned, stoppedAtLimit: false };
}

export const _testCollectSandboxStream = collectSandboxStream;

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
export const _testWaitForSnapshotConflictWinner = waitForSnapshotConflictWinner;
export const _testIsSnapshotNameConflict = isSnapshotNameConflict;
export const _testProviderCanRebuildSnapshot = providerCanRebuildSnapshot;
export const _testImageMap = IMAGE_MAP;
export const _testWithEndOfOutputSentinel = withEndOfOutputSentinel;
export const _testStripEndOfOutputSentinel = stripEndOfOutputSentinel;
export const _testSettledStreams = settledStreams;
export const _testCreateSentinelFilter = createSentinelFilter;
export const _testCreateLogDemuxer = createLogDemuxer;
export const _testFollowManagedSessionLogs = followManagedSessionLogs;
export const _testReadCommandStreams = readCommandStreams;
