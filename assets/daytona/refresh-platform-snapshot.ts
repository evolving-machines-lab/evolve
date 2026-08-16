/**
 * Move MANAGED Daytona onto the current release image.
 *
 * Usage:
 *   npx tsx refresh-platform-snapshot.ts [--dry-run]
 *
 * Run by .github/workflows/image-refresh.yml after the image is on Docker Hub.
 * MAINTAINER/PLATFORM tooling: it writes to the platform's own Daytona org.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT HAS TO EXIST, AND WHY IT IS SHAPED LIKE THIS
 * ---------------------------------------------------------------------------
 * Direct-mode Daytona users are already handled by content addressing: the
 * provider defaults to the snapshot name `evolve-all-c-<12hex>` and builds it
 * on first use, so a new release reaches them with nothing to run here.
 *
 * MANAGED mode is the one that needs help. The SDK's managed default is the
 * bare, stable name "evolve-all" (packages/daytona/src/index.ts), managed
 * creates never build, and the dashboard's managed door serves no /snapshots
 * endpoints — so nothing in the request path can move that name onto a new
 * release. Worse, the platform never even sees a different name to point at:
 * DAYTONA_PLATFORM_SNAPSHOT only tells the dashboard's warm keeper which
 * snapshot to keep awake, it does NOT rewrite the name a managed create asks
 * for. The literal name "evolve-all" must exist, be active, and be built from
 * the release we want people on. That is what this script guarantees.
 *
 * DAYTONA CANNOT REPOINT A NAME. This is the constraint everything below is
 * bent around, and it is worth stating precisely because the safe-looking
 * motion does not exist. Daytona's API (verified against the live OpenAPI
 * document at https://api.daytona.io/openapi.json) offers exactly:
 *   POST   /snapshots               create
 *   GET    /snapshots, /snapshots/{id}
 *   DELETE /snapshots/{id}
 *   POST   /snapshots/{id}/activate, /deactivate
 * There is no PATCH or PUT on a snapshot, no rename, and no way to swap the
 * image behind an existing name. Creating over a live name returns 409
 * (DaytonaConflictError). Daytona knows: daytonaio/daytona issue #2661
 * ("Update Existing Snapshots", open) states the immutability, says the
 * delete-then-recreate workaround "is non-atomic and introduces downtime
 * risks", and proposes a PATCH that does not exist yet.
 *
 * So a stable managed name can only be moved by DELETE then CREATE, and there
 * is a real window in between where a managed create would fail. That window
 * cannot be removed with today's API — it can only be made short, rare, and
 * survivable, which is the whole design of this file:
 *
 *   1. BUILD THE VERSIONED SNAPSHOT FIRST, and refuse to go on unless it
 *      reaches `active`. `evolve-all-c-<12hex>` is a NEW name, so this step
 *      touches nothing that is live. It is also the proof that matters: the
 *      release image pulls, builds and activates in THIS org. Every way the
 *      swap could fail after the delete — bad tag, unpullable image, broken
 *      registry credentials, a Daytona-side build failure — has already been
 *      ruled out before anything is destroyed. It doubles as the pre-build
 *      direct-mode users would otherwise pay for on first use.
 *   2. DO NOTHING IF NOTHING CHANGED. The platform snapshot records which ref
 *      built it, so a re-run on an unchanged release is a read and a no-op.
 *      The dangerous path is not entered out of habit.
 *   3. PRESERVE THE CONTRACT. The replacement is created with the sizing,
 *      entrypoint, region and sandbox class read off the snapshot being
 *      replaced, not with this repo's defaults. Only the image may change.
 *   4. NEVER ENTER THE DESTRUCTIVE PATH WITHOUT A WAY OUT. The planner refuses
 *      (`blocked`) when the snapshot records no image ref, because that is the
 *      one case where a failed rebuild could not be undone. So the decision is
 *      made BEFORE the delete, not discovered in the failure handler once the
 *      snapshot is already gone — which is why `replace` carries a REQUIRED
 *      `from` rather than an optional one.
 *   5. ROLL BACK, AND CLEAR THE WRECKAGE FIRST. A failed create leaves a row
 *      under the name in ERROR/BUILD_FAILED (the SDK only throws once it has
 *      reached a terminal state), so the rollback deletes that row before
 *      rebuilding from the old ref — otherwise the rollback itself would 409
 *      and the fleet would be left with nothing. The job still fails; the
 *      fleet gets its bootable snapshot back.
 *   6. BOUND EVERY WAIT. The SDK's create polls forever (its `timeout` covers
 *      only the initial POST), and being killed by the job timeout mid-swap is
 *      the one outcome with no recovery, because no rollback would run.
 *
 * WHAT IS STILL LOST, HONESTLY. Deleting a snapshot also deletes its warm
 * pools and destroys their unclaimed warm sandboxes (Daytona's own docs).
 * Those refill, but the first managed creates after a swap pay a cold start.
 * Whether an ALREADY-RUNNING sandbox survives its snapshot's deletion is not
 * documented by Daytona either way, and this script does not assume it does.
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Daytona, Image } from '@daytonaio/sdk'
import { EVOLVE_IMAGE_REF, SNAPSHOT_NAME, SNAPSHOT_RESOURCES } from './template'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The stable name managed creates ask for. The env override exists so a
 * staging org can be refreshed without editing code; it must match the
 * dashboard's DAYTONA_PLATFORM_SNAPSHOT (lib/evaluations/worker/
 * daytona-snapshot-warm.ts) or the warm keeper will hold a different name
 * awake than the one this script maintains.
 */
const PLATFORM_SNAPSHOT_NAME = process.env.DAYTONA_PLATFORM_SNAPSHOT || 'evolve-all'

/** Snapshot builds pull a ~7 GiB image; give them room but not forever. */
const CREATE_TIMEOUT_S = 30 * 60
const ACTIVE_TIMEOUT_MS = 20 * 60 * 1000
const ACTIVE_POLL_MS = 5000
const DELETE_GONE_TIMEOUT_MS = 5 * 60 * 1000
const DELETE_GONE_POLL_MS = 3000

/** Daytona's own SnapshotState enum, split by what it means for this script. */
const TRANSITIONAL_STATES = new Set(['pending', 'building', 'pulling', 'snapshotting', 'removing'])
const FAILED_STATES = new Set(['error', 'build_failed'])

/** The snapshot fields this script reads. Structural on purpose: the SDK does
 *  not export its branded `Snapshot` type from the package root. */
export type SnapshotFacts = {
  name?: string
  state?: string
  imageName?: string
  entrypoint?: string[] | null
  cpu?: number
  mem?: number
  disk?: number
  /** Regions the snapshot is published to. Create takes ONE (`regionId`). */
  regionIds?: string[] | null
  /** Which runners may host sandboxes from it — 'container', 'linux-vm', ... */
  sandboxClass?: string | null
  buildInfo?: { dockerfileContent?: string | null } | null
}

/** What the platform snapshot needs, given what it currently is. */
export type SnapshotPlan =
  | { action: 'noop'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'activate'; reason: string }
  | { action: 'create'; reason: string }
  /**
   * Delete and rebuild. `from` is REQUIRED, not optional, and that is the
   * safety property rather than a typing detail: the only way back out of the
   * destructive path is rebuilding the old image, so a replace that cannot name
   * one must never be representable. When there is no recoverable ref the
   * planner returns `blocked` instead — see below.
   */
  | { action: 'replace'; reason: string; from: string }
  /**
   * The snapshot is wrong AND records no image ref to return to. Refusing is
   * the right answer: deleting here trades a stale fleet for a fleet with no
   * bootable snapshot and no way to restore one. An operator has to look.
   */
  | { action: 'blocked'; reason: string }

/**
 * Compare image refs the way a registry would. Daytona echoes back what it was
 * given, and `docker.io/library/x` and `x` are the same image; treating them as
 * different would delete and rebuild a snapshot that was already correct.
 */
export function normalizeImageRef(ref: string): string {
  return ref
    .trim()
    .replace(/^index\.docker\.io\//, '')
    .replace(/^docker\.io\//, '')
    .replace(/^library\//, '')
}

/**
 * Which image ref backs this snapshot, or undefined when Daytona does not say.
 *
 * TWO SHAPES, because Daytona records the answer in two different places
 * depending on how the snapshot was made, and this script must read both to
 * stay idempotent:
 *   - created from a plain registry string  → `imageName` holds the ref
 *   - created from an `Image` (what this repo does, via Image.base) → the ref
 *     lives in `buildInfo.dockerfileContent` as its FROM line, and `imageName`
 *     comes back as an empty string
 * The live platform snapshot is the second shape, so reading only `imageName`
 * would see "" every time, never match, and swap the fleet on every single run.
 */
export function backingImageRef(facts: SnapshotFacts): string | undefined {
  const named = typeof facts.imageName === 'string' ? facts.imageName.trim() : ''
  if (named !== '') return named
  const dockerfile = facts.buildInfo?.dockerfileContent
  if (typeof dockerfile !== 'string') return undefined
  return /^[ \t]*FROM[ \t]+(\S+)/im.exec(dockerfile)?.[1]
}

/**
 * The single decision this script makes about the platform snapshot. Pure, so
 * the dangerous branch can be tested without a Daytona account — see
 * packages/daytona/tests/unit/daytona-image-refresh.test.ts.
 */
export function planPlatformSnapshot(
  current: SnapshotFacts | undefined,
  targetRef: string
): SnapshotPlan {
  if (!current) {
    return { action: 'create', reason: 'the snapshot does not exist' }
  }
  const state = current.state ?? 'unknown'
  const backing = backingImageRef(current)
  const onTarget = backing !== undefined && normalizeImageRef(backing) === normalizeImageRef(targetRef)

  if (onTarget) {
    if (state === 'active') return { action: 'noop', reason: `already built from ${targetRef} and active` }
    if (state === 'inactive') return { action: 'activate', reason: `already built from ${targetRef} but inactive` }
    if (TRANSITIONAL_STATES.has(state)) return { action: 'wait', reason: `already built from ${targetRef}, state "${state}"` }
    // Right image, dead build. Activation cannot heal a failed build, so the
    // name has to be rebuilt — the same destructive path as a real swap.
    return { action: 'replace', reason: `built from ${targetRef} but in failed state "${state}"`, from: backing }
  }

  // Wrong image. A snapshot mid-transition is somebody else's build in flight
  // (the other half of a previous run, or a concurrent one); tearing it down
  // would race that build for the name, so wait and re-read instead.
  if (TRANSITIONAL_STATES.has(state)) {
    return { action: 'wait', reason: `state "${state}" — a build is already in flight for this name` }
  }
  // No recorded ref means no way back, and that has to be decided HERE, before
  // anything is deleted — not discovered in the failure handler once the
  // snapshot is already gone.
  if (backing === undefined) {
    return {
      action: 'blocked',
      reason:
        `it records no image ref, so a delete-and-rebuild could not be undone if the rebuild failed. ` +
        `Rebuild "${PLATFORM_SNAPSHOT_NAME}" by hand from a known-good image, or delete it deliberately`,
    }
  }
  return {
    action: 'replace',
    reason: `built from ${backing}, wanted ${targetRef}`,
    from: backing,
  }
}

/**
 * Does this failure mean the snapshot is not there? Mirrors the provider's own
 * isMissingSnapshot (packages/daytona/src/index.ts) — kept local because that
 * one is not exported, and assets/ must not reach into a package's internals.
 */
function isMissingSnapshot(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('not found') || m.includes('404') || m.includes('does not exist')
}

type SnapshotHandle = Awaited<ReturnType<Daytona['snapshot']['get']>>

/**
 * The slice of the Daytona client this script uses. Structural rather than the
 * concrete class so the destructive path can be driven by a fake in
 * packages/daytona/tests/unit/daytona-image-refresh.test.ts — the rollback
 * sequence is the one piece of this file that must never be wrong and can never
 * be rehearsed against the real org, because rehearsing it means deleting the
 * production snapshot. `Daytona` satisfies this as-is.
 */
export interface SnapshotClient {
  snapshot: {
    get(name: string): Promise<SnapshotHandle>
    create(
      params: { name: string; image: unknown; resources?: unknown; entrypoint?: string[] },
      options?: { onLogs?: (chunk: string) => void; timeout?: number }
    ): Promise<unknown>
    delete(snapshot: SnapshotHandle): Promise<unknown>
    activate(snapshot: SnapshotHandle): Promise<unknown>
  }
}

/** The snapshot, or undefined when absent. Throws on an API that cannot answer:
 *  reading "cannot tell" as "absent" would turn an outage into a create. */
async function getSnapshot(daytona: SnapshotClient, name: string): Promise<SnapshotHandle | undefined> {
  try {
    return await daytona.snapshot.get(name)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isMissingSnapshot(message)) return undefined
    throw new Error(`Reading Daytona snapshot "${name}" failed: ${message}`)
  }
}

const facts = (handle: SnapshotHandle): SnapshotFacts => handle as unknown as SnapshotFacts

function describe(handle: SnapshotHandle): string {
  const f = facts(handle)
  return `state "${f.state}", built from ${backingImageRef(f) ?? '(unrecorded)'}`
}

/** Poll until the snapshot reports `active`, or say exactly why it never did. */
async function waitForActive(daytona: SnapshotClient, name: string): Promise<SnapshotHandle> {
  const deadline = Date.now() + ACTIVE_TIMEOUT_MS
  let last = ''
  for (;;) {
    const handle = await getSnapshot(daytona, name)
    const state = handle ? (facts(handle).state ?? 'unknown') : 'absent'
    if (handle && state === 'active') return handle
    if (FAILED_STATES.has(state)) {
      throw new Error(`Snapshot "${name}" reached terminal state "${state}"`)
    }
    if (state !== last) {
      console.log(`    waiting — state "${state}"`)
      last = state
    }
    if (Date.now() > deadline) {
      throw new Error(`Snapshot "${name}" did not reach "active" within ${ACTIVE_TIMEOUT_MS / 1000}s (state "${state}")`)
    }
    await new Promise((r) => setTimeout(r, ACTIVE_POLL_MS))
  }
}

/**
 * Fail `work` if it has not settled within `ms`.
 *
 * Exists because the Daytona SDK's snapshot create is UNBOUNDED: its `timeout`
 * option is passed only as the axios timeout on the initial POST, and the loop
 * that follows polls `get()` every second until a terminal state with no
 * deadline at all (node_modules/@daytonaio/sdk/esm/Snapshot.js). A build wedged
 * in `building` would hang until the JOB is killed — and being killed mid-swap
 * is the one outcome with no recovery, because the platform snapshot is already
 * deleted by then and no rollback would ever run. This turns that into an
 * ordinary rejection the caller can roll back from.
 *
 * The timer is always cleared, so a resolved race never holds the event loop
 * open — this runs in a one-shot script that must exit.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Everything about a snapshot except its image — what a replacement must keep. */
export type SnapshotShape = {
  resources: { cpu: number; memory: number; disk: number }
  entrypoint: string[] | undefined
  regionId: string | undefined
  sandboxClass: string | undefined
}

/**
 * Create the snapshot and wait for it to be usable.
 *
 * `Image.base(ref)` rather than the plain ref string on purpose: it is what
 * assets/daytona/build.ts already uses, and it is the shape whose recorded
 * result this repo has actually observed — Daytona stores it as
 * `buildInfo.dockerfileContent = "FROM <ref>\n"`, which is exactly what
 * backingImageRef() reads back. Creating one way and reading another is how an
 * idempotent check quietly becomes a swap-every-run.
 *
 * THE CREATE IS BOUNDED HERE, BECAUSE THE SDK DOES NOT BOUND IT. Its `timeout`
 * option is passed only as the axios timeout on the initial POST
 * (node_modules/@daytonaio/sdk/esm/Snapshot.js) — the loop that follows polls
 * `get()` every second until a terminal state with no deadline at all. A build
 * wedged in `building` would therefore hang until the JOB is killed, and being
 * killed mid-swap is the one outcome this script exists to avoid: the platform
 * snapshot is already deleted by then, and no rollback would ever run. The race
 * below converts that into an ordinary failure the caller can roll back from.
 */
async function createSnapshot(
  daytona: SnapshotClient,
  name: string,
  ref: string,
  shape: SnapshotShape
): Promise<void> {
  const { resources, entrypoint, regionId, sandboxClass } = shape
  await withDeadline(
    daytona.snapshot.create(
      {
        name,
        image: Image.base(ref),
        resources,
        ...(entrypoint && entrypoint.length > 0 ? { entrypoint } : {}),
        ...(regionId ? { regionId } : {}),
        ...(sandboxClass ? { sandboxClass: sandboxClass as never } : {}),
      },
      { onLogs: (log) => console.log(`    ${log}`), timeout: CREATE_TIMEOUT_S }
    ),
    CREATE_TIMEOUT_S * 1000,
    `Snapshot "${name}" build exceeded ${CREATE_TIMEOUT_S}s and was abandoned`
  )
  await waitForActive(daytona, name)
}

/** The default shape for a snapshot this repo owns outright (versioned names). */
const REPO_SHAPE: SnapshotShape = {
  resources: { ...SNAPSHOT_RESOURCES },
  entrypoint: undefined,
  regionId: undefined,
  sandboxClass: undefined,
}

/**
 * Everything a replacement must carry over from the snapshot it replaces. Only
 * the IMAGE is allowed to change; falling back to this repo's defaults would
 * silently resize managed sandboxes, drop the entrypoint that keeps the
 * container alive, or publish the replacement to a different region or runner
 * class than the fleet books against.
 *
 * VERIFIED AGAINST THE LIVE RECORDS, because the round-trip is the whole
 * question here — a field Daytona does not report back on GET is a field the
 * NEXT replace would silently drop. Both `evolve-all` and
 * `evolve-all-c-6cd57962a3d9` were created from an `Image` passing none of
 * these, and Daytona still reports entrypoint ["sleep","infinity"], regionIds
 * ["us"] and sandboxClass "container" on GET. So reading them back and
 * re-passing them genuinely preserves them.
 */
export function preservedShape(before: SnapshotFacts): SnapshotShape {
  return {
    resources: {
      cpu: before.cpu ?? SNAPSHOT_RESOURCES.cpu,
      memory: before.mem ?? SNAPSHOT_RESOURCES.memory,
      disk: before.disk ?? SNAPSHOT_RESOURCES.disk,
    },
    entrypoint: before.entrypoint ?? undefined,
    // Create accepts a single regionId while the record lists many. One region
    // is the only case that round-trips exactly; more than one cannot be
    // expressed, so leave it to the org default rather than silently narrowing
    // the fleet to whichever region happens to sort first.
    regionId: before.regionIds?.length === 1 ? before.regionIds[0] : undefined,
    sandboxClass: before.sandboxClass ?? undefined,
  }
}

/**
 * Delete, then poll until the name stops resolving — Daytona's delete is
 * asynchronous, and a create fired at a name still being carried out loses it.
 *
 * Returns whether the name is CONFIRMED clear. A timeout is deliberately NOT a
 * throw: by the time we are here the snapshot is already deleted or dying, so
 * refusing to go on would strand the fleet with no snapshot and no attempt to
 * rebuild one. The caller tries the create anyway — it may well succeed, and if
 * it does not, the ordinary rollback path runs. What a timeout does earn is a
 * loud line, because it means managed creates are probably failing right now.
 *
 * Tolerates an already-gone snapshot: deleting a row that vanished underneath
 * us is the outcome we wanted, not an error.
 */
async function deleteAndConfirmGone(
  daytona: SnapshotClient,
  handle: SnapshotHandle,
  name: string
): Promise<boolean> {
  try {
    await daytona.snapshot.delete(handle)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!isMissingSnapshot(message)) throw new Error(`Deleting snapshot "${name}" failed: ${message}`)
    console.log(`    "${name}" was already gone.`)
  }
  const deadline = Date.now() + DELETE_GONE_TIMEOUT_MS
  for (;;) {
    if ((await getSnapshot(daytona, name)) === undefined) return true
    if (Date.now() > deadline) {
      console.error(
        `::warning::Snapshot "${name}" still resolves ${DELETE_GONE_TIMEOUT_MS / 1000}s after deletion. ` +
          `MANAGED CREATES MAY BE FAILING RIGHT NOW. Attempting the rebuild anyway — a create that loses ` +
          `the name to the dying row will fail and be rolled back.`
      )
      return false
    }
    await new Promise((r) => setTimeout(r, DELETE_GONE_POLL_MS))
  }
}

/**
 * STEP 1 — the versioned snapshot. A new name, so nothing live is touched, and
 * reaching `active` is the proof that the release image works in this org.
 */
async function ensureVersionedSnapshot(daytona: SnapshotClient, dryRun: boolean): Promise<void> {
  console.log(`\n▸ Versioned snapshot "${SNAPSHOT_NAME}" (direct-mode default, and the swap's safety proof)`)
  const existing = await getSnapshot(daytona, SNAPSHOT_NAME)
  const plan = planPlatformSnapshot(existing ? facts(existing) : undefined, EVOLVE_IMAGE_REF)
  console.log(`  ${existing ? describe(existing) : 'absent'} → ${plan.action} (${plan.reason})`)

  if (dryRun) return
  switch (plan.action) {
    case 'noop':
      return
    case 'wait':
      await waitForActive(daytona, SNAPSHOT_NAME)
      return
    case 'activate':
      await daytona.snapshot.activate(existing!)
      await waitForActive(daytona, SNAPSHOT_NAME)
      return
    case 'create':
      await createSnapshot(daytona, SNAPSHOT_NAME, EVOLVE_IMAGE_REF, REPO_SHAPE)
      return
    case 'replace':
    case 'blocked':
      // A versioned name is content-addressed, so a wrong or dead build under
      // it is junk with no users to protect — unlike the platform name, whose
      // `blocked` verdict is a genuine refusal. Here there is nothing to
      // preserve and nothing to roll back to, so rebuild it outright.
      await deleteAndConfirmGone(daytona, existing!, SNAPSHOT_NAME)
      await createSnapshot(daytona, SNAPSHOT_NAME, EVOLVE_IMAGE_REF, REPO_SHAPE)
      return
  }
}

/** STEP 2 — the stable managed name. The only destructive path in this file. */
async function refreshPlatformSnapshot(daytona: SnapshotClient, dryRun: boolean): Promise<void> {
  console.log(`\n▸ Platform snapshot "${PLATFORM_SNAPSHOT_NAME}" (what MANAGED creates ask for)`)
  let existing = await getSnapshot(daytona, PLATFORM_SNAPSHOT_NAME)
  let plan = planPlatformSnapshot(existing ? facts(existing) : undefined, EVOLVE_IMAGE_REF)
  console.log(`  ${existing ? describe(existing) : 'absent'} → ${plan.action} (${plan.reason})`)

  if (dryRun) {
    if (plan.action === 'replace') {
      const f = facts(existing!)
      console.log(
        `  DRY RUN: would delete and rebuild "${PLATFORM_SNAPSHOT_NAME}" from ${EVOLVE_IMAGE_REF},\n` +
          `  preserving ${f.cpu}cpu/${f.mem}gb/${f.disk}gb, entrypoint ${JSON.stringify(f.entrypoint)}, ` +
          `regions ${JSON.stringify(f.regionIds)}, class ${JSON.stringify(f.sandboxClass)},\n` +
          `  and rolling back to ${plan.from} if the rebuild fails.`
      )
    }
    if (plan.action === 'blocked') {
      console.log(`  DRY RUN: would REFUSE to act — ${plan.reason}.`)
    }
    return
  }

  // A build in flight is not ours to interrupt: wait it out, then decide again
  // against what it actually produced.
  if (plan.action === 'wait') {
    await waitForActive(daytona, PLATFORM_SNAPSHOT_NAME)
    existing = await getSnapshot(daytona, PLATFORM_SNAPSHOT_NAME)
    plan = planPlatformSnapshot(existing ? facts(existing) : undefined, EVOLVE_IMAGE_REF)
    console.log(`  re-planned after waiting → ${plan.action} (${plan.reason})`)
  }

  switch (plan.action) {
    case 'noop':
      console.log('  Nothing to do — managed users are already on this release.')
      return
    case 'wait':
      // Reached only when the re-plan above STILL says wait: we waited, and the
      // name is somehow transitional again. That is not a refresh, and calling
      // it one would report managed users as moved when nobody checked.
      throw new Error(
        `Snapshot "${PLATFORM_SNAPSHOT_NAME}" is still mid-transition after waiting — this run does not ` +
          `know whether managed Daytona is on ${EVOLVE_IMAGE_REF}. Re-run once it settles.`
      )
    case 'blocked':
      throw new Error(`Refusing to touch "${PLATFORM_SNAPSHOT_NAME}": ${plan.reason}.`)
    case 'activate':
      await daytona.snapshot.activate(existing!)
      await waitForActive(daytona, PLATFORM_SNAPSHOT_NAME)
      console.log('  Reactivated.')
      return
    case 'create':
      await createSnapshot(daytona, PLATFORM_SNAPSHOT_NAME, EVOLVE_IMAGE_REF, REPO_SHAPE)
      console.log('  Created.')
      return
    case 'replace':
      await replacePlatformSnapshot(daytona, existing!, plan.from)
      return
  }
}

/**
 * The swap. Everything Daytona's API makes possible to keep this survivable is
 * done here; the gap between the delete and the new snapshot going active is
 * the part that cannot be removed (see the header).
 */
export async function replacePlatformSnapshot(
  daytona: SnapshotClient,
  existing: SnapshotHandle,
  previousRef: string
): Promise<void> {
  const before = facts(existing)
  const shape = preservedShape(before)
  if ((before.regionIds?.length ?? 0) > 1) {
    console.error(
      `::warning::"${PLATFORM_SNAPSHOT_NAME}" is published to ${JSON.stringify(before.regionIds)} but ` +
        `Daytona's create takes only one region — the replacement will use the organization default.`
    )
  }

  console.log(
    `  Daytona has no rename and no in-place update (issue #2661), so the stable name is\n` +
      `  delete-then-create. Managed creates can fail until the new build is active.\n` +
      `  Preserving ${shape.resources.cpu}cpu/${shape.resources.memory}gb/${shape.resources.disk}gb, ` +
      `entrypoint ${JSON.stringify(shape.entrypoint)}, region ${shape.regionId ?? '(default)'}, ` +
      `class ${shape.sandboxClass ?? '(default)'}.\n` +
      `  Rollback ref if the create fails: ${previousRef}`
  )

  await deleteAndConfirmGone(daytona, existing, PLATFORM_SNAPSHOT_NAME)
  console.log(`  Deleted. Building "${PLATFORM_SNAPSHOT_NAME}" from ${EVOLVE_IMAGE_REF}...`)

  try {
    await createSnapshot(daytona, PLATFORM_SNAPSHOT_NAME, EVOLVE_IMAGE_REF, shape)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`::error::Rebuilding "${PLATFORM_SNAPSHOT_NAME}" from ${EVOLVE_IMAGE_REF} failed: ${message}`)
    console.error(`::warning::Rolling "${PLATFORM_SNAPSHOT_NAME}" back to ${previousRef}...`)
    try {
      // CLEAR THE FAILED ROW FIRST. The SDK only throws once the snapshot has
      // reached ERROR or BUILD_FAILED, which means the row EXISTS under this
      // name at the moment we get here — so a rollback create would collide
      // with it and 409, turning a recoverable failure into a fleet with no
      // snapshot. The same applies when the create timed out above: whatever
      // is sitting under the name has to go before the name is free.
      const failed = await getSnapshot(daytona, PLATFORM_SNAPSHOT_NAME)
      if (failed) {
        console.error(`  Clearing the failed "${PLATFORM_SNAPSHOT_NAME}" row before rebuilding...`)
        await deleteAndConfirmGone(daytona, failed, PLATFORM_SNAPSHOT_NAME)
      }
      await createSnapshot(daytona, PLATFORM_SNAPSHOT_NAME, previousRef, shape)
    } catch (rollbackErr) {
      const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      throw new Error(
        `ROLLBACK ALSO FAILED (${detail}). Managed Daytona has no "${PLATFORM_SNAPSHOT_NAME}" snapshot and ` +
          `managed creates are failing NOW. Rebuild it by hand from ${previousRef}.`
      )
    }
    throw new Error(
      `Refresh failed and was rolled back: "${PLATFORM_SNAPSHOT_NAME}" is serving ${previousRef} again. ` +
        `Managed users stay on the previous release.`
    )
  }

  console.log(`  ✓ "${PLATFORM_SNAPSHOT_NAME}" now serves ${EVOLVE_IMAGE_REF}.`)
}

async function main() {
  config({ path: resolve(__dirname, '../../.env') })
  const dryRun = process.argv.includes('--dry-run')
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Daytona Platform Refresh       ║')
  console.log('╚════════════════════════════════════════╝')
  console.log(`\nRelease image: ${EVOLVE_IMAGE_REF}`)
  if (dryRun) console.log('DRY RUN — reads only, nothing is created, deleted or activated.')
  if (!process.env.DAYTONA_API_KEY) throw new Error('DAYTONA_API_KEY is not set (repo-root .env, or the CI secret of the same name)')

  // useDeprecatedPolling: since 0.203 the bare constructor opens a socket.io
  // WebSocket for lifecycle events, which nothing here consumes and which would
  // keep this one-shot script's event loop alive forever. Same flag, same
  // reason, as packages/daytona and assets/daytona/build.ts.
  const daytona = new Daytona({ useDeprecatedPolling: true })

  // Order is the safety property: the versioned build proves the image is good
  // in this org BEFORE the stable name is ever deleted.
  await ensureVersionedSnapshot(daytona, dryRun)
  await refreshPlatformSnapshot(daytona, dryRun)

  console.log(dryRun ? '\n✓ Dry run complete.' : '\n✓ Daytona is on the current release.')
}

// Run only when invoked directly. The planning helpers above are imported by
// packages/daytona/tests/unit/daytona-image-refresh.test.ts, and an
// unconditional main() would have that unit test talk to the real Daytona org.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
