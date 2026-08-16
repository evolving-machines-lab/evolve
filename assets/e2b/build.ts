/**
 * Build the public `evolve-all` E2B template.
 *
 * Usage: npx tsx build.ts   (or: cd assets && ./build.sh e2b)
 *
 * This is for MAINTAINERS only. Users don't need to run this — the template is
 * public and works out of the box.
 *
 * E2B IS NOT PART OF THE CONTENT-TAG LAW. Modal caches images by reference and
 * Daytona caches snapshots by name, so those two need one immutable
 * `c-<12hex>` name per release to reach users. E2B resolves the alias
 * `evolve-all` to whatever its LATEST successful build is, so the template is
 * rebuilt in place and users move the moment the build lands — no release, no
 * version bump, nothing to publish.
 *
 * WHY THIS SCRIPT VERIFIES INSTEAD OF TRUSTING ITS EXIT CODE. Two independent
 * reasons, both learned the hard way:
 *   - This file used to end in `main().catch(console.error)`, which PRINTS a
 *     failure and then exits 0. A failed build reported success to every
 *     caller, CI included. It now exits 1.
 *   - Even a clean resolve is only the builder's own opinion. The thing that
 *     actually matters is E2B's record: the alias must resolve to a NEW build
 *     id whose status is `ready`. So the script reads the template list before
 *     and after and refuses to call the build done until E2B agrees.
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** The public alias users pass as `template: 'evolve-all'`. */
const ALIAS = 'evolve-all'

/** How long E2B may take to publish the finished build in its own record. */
const READY_TIMEOUT_MS = 10 * 60 * 1000
const READY_POLL_MS = 5000

/** The fields this script reads from one row of `GET /templates`. */
export type TemplateRow = {
  templateID?: string
  aliases?: string[]
  buildID?: string
  /** E2B's own enum: 'building' | 'waiting' | 'ready' | 'error'. */
  buildStatus?: string
}

/** What E2B's record says about a build we are waiting on. */
export type BuildVerdict =
  /** A new build is published and ready — the only success. */
  | { outcome: 'ready' }
  /** E2B says the build failed. A verdict, not something to keep polling. */
  | { outcome: 'failed'; detail: string }
  /** Not there yet; keep waiting. `detail` is for the progress line. */
  | { outcome: 'pending'; detail: string }

/**
 * The whole verification rule, in one pure place.
 *
 * `buildID` is documented as the last SUCCESSFUL build, so an unchanged id is
 * the signal that no new build succeeded — which is precisely the failure the
 * old `main().catch(console.error)` used to swallow while exiting 0. "Ready"
 * alone is not enough: a failed rebuild leaves the PREVIOUS build sitting there
 * ready, and accepting that would call a broken refresh a success.
 */
export function verifyBuildRow(
  row: TemplateRow | undefined,
  previousBuildID: string | undefined
): BuildVerdict {
  if (!row) return { outcome: 'pending', detail: 'template not listed yet' }
  if (row.buildStatus === 'error') {
    return { outcome: 'failed', detail: `build ${row.buildID ?? '(unknown)'} is in state "error"` }
  }
  if (row.buildStatus !== 'ready' || !row.buildID) {
    return { outcome: 'pending', detail: `build ${row.buildID ?? '(none)'} status "${row.buildStatus}"` }
  }
  if (row.buildID === previousBuildID) {
    return { outcome: 'pending', detail: `still serving the previous build ${row.buildID}` }
  }
  return { outcome: 'ready' }
}

/** Same host the SDK talks to; E2B_DOMAIN override honoured. */
function apiBase(): string {
  return `https://api.${process.env.E2B_DOMAIN || 'e2b.app'}`
}

/**
 * The `evolve-all` row from E2B's template list, or undefined when the
 * template does not exist yet (first ever build). Throws — never guesses — on
 * an unusable API, because "no row" and "cannot tell" must not look alike:
 * treating an unreachable API as "template absent" would let a broken build
 * pass the new-build-id check below.
 */
async function readTemplate(): Promise<TemplateRow | undefined> {
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) throw new Error('E2B_API_KEY is not set (repo-root .env, or the CI secret of the same name)')
  const res = await fetch(`${apiBase()}/templates`, { headers: { 'X-API-KEY': apiKey } })
  if (!res.ok) throw new Error(`GET /templates -> HTTP ${res.status} ${res.statusText}`)
  const rows: unknown = await res.json()
  if (!Array.isArray(rows)) throw new Error('GET /templates -> unrecognized body (expected an array)')
  return (rows as TemplateRow[]).find((row) => (row.aliases ?? []).includes(ALIAS))
}

/**
 * Wait until E2B reports a build that is BOTH new and `ready`.
 *
 * `buildID` is documented as the last SUCCESSFUL build, so an unchanged id
 * after a build means no new build succeeded — the exact failure the old
 * exit-0 bug used to hide. A build that reaches `error` is a verdict, not
 * something to keep polling.
 */
async function waitForReadyBuild(previousBuildID: string | undefined): Promise<TemplateRow> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = ''
  for (;;) {
    const row = await readTemplate()
    const verdict = verifyBuildRow(row, previousBuildID)
    if (verdict.outcome === 'ready') return row as TemplateRow
    if (verdict.outcome === 'failed') {
      throw new Error(`E2B reports template "${ALIAS}": ${verdict.detail}`)
    }
    if (verdict.detail !== last) {
      console.log(`  waiting — ${verdict.detail}`)
      last = verdict.detail
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Template "${ALIAS}" did not reach a new ready build within ${READY_TIMEOUT_MS / 1000}s — ${verdict.detail}`
      )
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS))
  }
}

async function main() {
  config({ path: resolve(__dirname, '../../.env') })
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve E2B Template Builder           ║')
  console.log('╚════════════════════════════════════════╝')

  const before = await readTemplate()
  console.log(
    before
      ? `\nTemplate "${ALIAS}" (${before.templateID}) currently serves build ${before.buildID} (${before.buildStatus}).`
      : `\nTemplate "${ALIAS}" does not exist yet — this is its first build.`
  )

  await Template.build(template, {
    alias: ALIAS,
    cpuCount: 4,
    memoryMB: 4096,
    skipCache: true,
    onBuildLogs: defaultBuildLogger(),
  })

  // The builder resolving is not the proof — E2B's own record is.
  console.log('\n▸ Verifying the template against the E2B API...')
  const after = await waitForReadyBuild(before?.buildID)
  console.log(`\n✓ Template "${ALIAS}" is ready — build ${after.buildID} (was ${before?.buildID ?? 'none'}).`)
  console.log('  E2B users are on the new template now; nothing to publish.')
}

// Run only when invoked directly, so verifyBuildRow() can be imported by
// packages/e2b/tests/unit/e2b-template-refresh.test.ts without building.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
