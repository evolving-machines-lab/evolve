/**
 * Writer for the image REFRESH STAMP — the coded way to say "rebuild it, the
 * inputs really did change", without faking an edit somewhere else.
 *
 * WHY IT EXISTS. The release tag is content-addressed over assets/docker/ (see
 * ./image-digest.ts). That is exactly right for a Dockerfile edit and exactly
 * wrong for the OTHER way this image changes: nearly every tool it installs is
 * pinned to `@latest`, so identical Dockerfile text describes a materially
 * different image once upstream moves. Same inputs derive the same tag, the
 * build is skipped as already-released, and the newer upstream tools never
 * reach anyone. Before this file, the only way out was to touch the Dockerfile
 * so the hash moved — a lie told to a hash function.
 *
 * The stamp closes that hole honestly, and does it by DESIGN rather than by
 * special case:
 *   - ./refresh-stamp is an ordinary file in the docker build context, so
 *     image-digest.ts already counts it as a build input (it hashes everything
 *     under assets/docker/ except the derivation machinery itself). No entry
 *     had to be added anywhere for a stamp bump to move the tag.
 *   - the Dockerfile COPYs it to /etc/evolve-image-refresh, so it is real
 *     image CONTENT, not a hash decoration. `cat /etc/evolve-image-refresh`
 *     inside a sandbox reports which refresh built the box it is running in.
 *
 * So rewriting the stamp genuinely changes the image, and the new tag it
 * derives is an honest content tag rather than a bumped version number.
 *
 * Usage: npx tsx write-refresh-stamp.ts "<reason>"
 *
 * .github/workflows/image-refresh.yml runs this on a `force_refresh` dispatch;
 * a maintainer can run it by hand for the same reason ("pick up today's CLI
 * releases") and commit the result.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The stamp file itself — a build input, hashed like any other. */
export const REFRESH_STAMP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'refresh-stamp')

/** The one machine-read line; everything above it is explanation for humans. */
const STAMP_LINE = /^refreshed:[ \t]*(.+?)[ \t]*$/m

/**
 * The stamp's payload, or undefined when the file carries no stamp line.
 * Parsing exists so the pipeline can PROVE a force run moved the stamp instead
 * of assuming the write landed.
 */
export function readRefreshStamp(source: string): string | undefined {
  return STAMP_LINE.exec(source)?.[1]
}

/** The full file body for a given stamp payload. Header lives here, once. */
export function refreshStampSource(stamp: string): string {
  return [
    '# Image refresh stamp — A BUILD INPUT BY DESIGN. Not generated code:',
    '# edit it, by hand or via `npx tsx write-refresh-stamp.ts "<reason>"`.',
    '#',
    '# assets/docker/image-digest.ts hashes every file in this directory that',
    '# the build context can carry, so changing the line below derives a new',
    '# c-<12hex> tag and the pipeline rebuilds and re-releases the image. That',
    '# is the point: the Dockerfile installs its tools with @latest, so the',
    '# same Dockerfile text can describe a materially different image once',
    '# upstream moves, and the content hash alone would never notice. Bumping',
    '# this stamp is how a maintainer says "the inputs really did change".',
    '#',
    '# The Dockerfile COPYs this file to /etc/evolve-image-refresh, so it is',
    '# genuine image content and not a hash decoration — a running sandbox can',
    '# report which refresh built it.',
    '',
    `refreshed: ${stamp}`,
    '',
  ].join('\n')
}

/**
 * Rewrite the stamp with `reason` at `now`. The timestamp carries seconds so
 * two runs of the same reason still differ — a stamp that did not change would
 * derive the same tag and silently skip the very rebuild it was asked for.
 *
 * Returns the stamp payload written.
 */
export function writeRefreshStamp(reason: string, now: Date = new Date()): string {
  const cleaned = reason.trim().replace(/\s+/g, ' ')
  const stamp = `${now.toISOString().replace(/\.\d+Z$/, 'Z')} — ${cleaned || 'manual refresh'}`
  writeFileSync(REFRESH_STAMP_PATH, refreshStampSource(stamp))
  return stamp
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const before = (() => {
    try {
      return readRefreshStamp(readFileSync(REFRESH_STAMP_PATH, 'utf-8'))
    } catch {
      return undefined
    }
  })()
  const stamp = writeRefreshStamp(process.argv.slice(2).join(' '))
  console.log(`Refresh stamp was: ${before ?? '(none)'}`)
  console.log(`Refresh stamp now: ${stamp}`)
  if (before === stamp) {
    console.error('::error::Refresh stamp did not change — the rebuild it was meant to force would be skipped.')
    process.exit(1)
  }
}
