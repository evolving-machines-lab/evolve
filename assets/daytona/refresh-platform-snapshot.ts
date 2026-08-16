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
 *   3. PRESERVE THE CONTRACT. The replacement is created with the sizing and
 *      entrypoint read off the snapshot being replaced, not with this repo's
 *      defaults. Only the image is allowed to change.
 *   4. ROLL BACK. The ref that backed the old snapshot is captured before the
 *      delete, so a failed create is followed by an immediate attempt to
 *      rebuild the name from the OLD image. The job still fails; the fleet
 *      gets its bootable snapshot back.
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
  buildInfo?: { dockerfileContent?: string | null } | null
}

/** What the platform snapshot needs, given what it currently is. */
export type SnapshotPlan =
  | { action: 'noop'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'activate'; reason: string }
  | { action: 'create'; reason: string }
  | { action: 'replace'; reason: string; from: string | undefined }

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
 * packages/daytona/tests/unit/daytona-platform-snapshot-plan.test.ts.
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
  return {
    action: 'replace',
    reason: `built from ${backing ?? 'an unrecorded image'}, wanted ${targetRef}`,
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

/** The snapshot, or undefined when absent. Throws on an API that cannot answer:
 *  reading "cannot tell" as "absent" would turn an outage into a create. */
async function getSnapshot(daytona: Daytona, name: string): Promise<SnapshotHandle | undefined> {
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
async function waitForActive(daytona: Daytona, name: string): Promise<SnapshotHandle> {
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
 * Create the snapshot and wait for it to be usable.
 *
 * `Image.base(ref)` rather than the plain ref string on purpose: it is what
 * assets/daytona/build.ts already uses, and it is the shape whose recorded
 * result this repo has actually observed — Daytona stores it as
 * `buildInfo.dockerfileContent = "FROM <ref>\n"`, which is exactly what
 * backingImageRef() reads back. Creating one way and reading another is how an
 * idempotent check quietly becomes a swap-every-run.
 */
async function createSnapshot(
  daytona: Daytona,
  name: string,
  ref: string,
  resources: { cpu: number; memory: number; disk: number },
  entrypoint: string[] | undefined
): Promise<void> {
  await daytona.snapshot.create(
    {
      name,
      image: Image.base(ref),
      resources,
      ...(entrypoint && entrypoint.length > 0 ? { entrypoint } : {}),
    },
    { onLogs: (log) => console.log(`    ${log}`), timeout: CREATE_TIMEOUT_S }
  )
  await waitForActive(daytona, name)
}

/** Delete, then poll until the name stops resolving — Daytona's delete is
 *  asynchronous, and a create fired at a name still being carried out loses. */
async function deleteAndConfirmGone(daytona: Daytona, handle: SnapshotHandle, name: string): Promise<void> {
  await daytona.snapshot.delete(handle)
  const deadline = Date.now() + DELETE_GONE_TIMEOUT_MS
  for (;;) {
    if ((await getSnapshot(daytona, name)) === undefined) return
    if (Date.now() > deadline) {
      throw new Error(`Snapshot "${name}" still resolves ${DELETE_GONE_TIMEOUT_MS / 1000}s after it was deleted`)
    }
    await new Promise((r) => setTimeout(r, DELETE_GONE_POLL_MS))
  }
}

/**
 * STEP 1 — the versioned snapshot. A new name, so nothing live is touched, and
 * reaching `active` is the proof that the release image works in this org.
 */
async function ensureVersionedSnapshot(daytona: Daytona, dryRun: boolean): Promise<void> {
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
      await createSnapshot(daytona, SNAPSHOT_NAME, EVOLVE_IMAGE_REF, { ...SNAPSHOT_RESOURCES }, undefined)
      return
    case 'replace':
      // A versioned name is content-addressed, so a wrong/dead build under it
      // is junk with no users to protect — unlike the platform name.
      await deleteAndConfirmGone(daytona, existing!, SNAPSHOT_NAME)
      await createSnapshot(daytona, SNAPSHOT_NAME, EVOLVE_IMAGE_REF, { ...SNAPSHOT_RESOURCES }, undefined)
      return
  }
}

/** STEP 2 — the stable managed name. The only destructive path in this file. */
async function refreshPlatformSnapshot(daytona: Daytona, dryRun: boolean): Promise<void> {
  console.log(`\n▸ Platform snapshot "${PLATFORM_SNAPSHOT_NAME}" (what MANAGED creates ask for)`)
  let existing = await getSnapshot(daytona, PLATFORM_SNAPSHOT_NAME)
  let plan = planPlatformSnapshot(existing ? facts(existing) : undefined, EVOLVE_IMAGE_REF)
  console.log(`  ${existing ? describe(existing) : 'absent'} → ${plan.action} (${plan.reason})`)

  if (dryRun) {
    if (plan.action === 'replace') {
      console.log(
        `  DRY RUN: would delete and rebuild "${PLATFORM_SNAPSHOT_NAME}" from ${EVOLVE_IMAGE_REF}, ` +
          `preserving sizing ${facts(existing!).cpu}cpu/${facts(existing!).mem}gb/${facts(existing!).disk}gb ` +
          `and entrypoint ${JSON.stringify(facts(existing!).entrypoint)}.`
      )
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
      return
    case 'activate':
      await daytona.snapshot.activate(existing!)
      await waitForActive(daytona, PLATFORM_SNAPSHOT_NAME)
      console.log('  Reactivated.')
      return
    case 'create':
      await createSnapshot(
        daytona,
        PLATFORM_SNAPSHOT_NAME,
        EVOLVE_IMAGE_REF,
        { ...SNAPSHOT_RESOURCES },
        undefined
      )
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
async function replacePlatformSnapshot(
  daytona: Daytona,
  existing: SnapshotHandle,
  previousRef: string | undefined
): Promise<void> {
  const before = facts(existing)
  // Preserve the CONTRACT of the snapshot being replaced — only the image may
  // change. Falling back to this repo's defaults would silently resize managed
  // sandboxes, or drop the entrypoint that keeps the container alive.
  const resources = {
    cpu: before.cpu ?? SNAPSHOT_RESOURCES.cpu,
    memory: before.mem ?? SNAPSHOT_RESOURCES.memory,
    disk: before.disk ?? SNAPSHOT_RESOURCES.disk,
  }
  const entrypoint = before.entrypoint ?? undefined

  console.log(
    `  Daytona has no rename and no in-place update (issue #2661), so the stable name is\n` +
      `  delete-then-create. Managed creates can fail until the new build is active.\n` +
      `  Preserving ${resources.cpu}cpu/${resources.memory}gb/${resources.disk}gb, entrypoint ${JSON.stringify(entrypoint)}.\n` +
      `  Rollback ref if the create fails: ${previousRef ?? 'NONE — cannot roll back'}`
  )

  await deleteAndConfirmGone(daytona, existing, PLATFORM_SNAPSHOT_NAME)
  console.log(`  Deleted. Building "${PLATFORM_SNAPSHOT_NAME}" from ${EVOLVE_IMAGE_REF}...`)

  try {
    await createSnapshot(daytona, PLATFORM_SNAPSHOT_NAME, EVOLVE_IMAGE_REF, resources, entrypoint)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`::error::Rebuilding "${PLATFORM_SNAPSHOT_NAME}" from ${EVOLVE_IMAGE_REF} failed: ${message}`)
    if (!previousRef) {
      throw new Error(
        `Managed Daytona has NO "${PLATFORM_SNAPSHOT_NAME}" snapshot and this run cannot restore one — ` +
          `the replaced snapshot recorded no image ref to roll back to. Managed creates fail until an ` +
          `operator rebuilds it.`
      )
    }
    console.error(`::warning::Rolling "${PLATFORM_SNAPSHOT_NAME}" back to ${previousRef}...`)
    try {
      await createSnapshot(daytona, PLATFORM_SNAPSHOT_NAME, previousRef, resources, entrypoint)
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
