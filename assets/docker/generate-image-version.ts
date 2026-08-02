/**
 * The generator behind the derived image version — `npm run
 * generate:image-version` (repo root; also runs first in `npm run build`).
 *
 * Computes the c-<12hex> tag from the image's build inputs (see
 * ./image-digest.ts) and REWRITES the three generated constants files. The
 * published packages ship standalone and cannot import assets/, so each
 * carries the value as a checked-in constant; the coherence test in
 * packages/daytona/tests/unit/daytona-image-version.test.ts recomputes the
 * digest and fails the suite whenever a checked-in copy is stale — that test
 * is the forcing function that replaced the human bump.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deriveImageVersion } from './image-digest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Body written to every generated file; quote style per surrounding package. */
function generatedSource(version: string, quote: "'" | '"'): string {
  const semi = quote === '"' ? ';' : ''
  return [
    '/**',
    ' * GENERATED — DO NOT EDIT. `npm run generate:image-version` (repo root)',
    ' * rewrites this file from the evolve-all image build inputs under',
    ' * assets/docker/ (see assets/docker/image-digest.ts for the derivation).',
    ' * The value is content-addressed: same inputs → same tag, any input',
    ' * change → a new tag. The coherence test in',
    ' * packages/daytona/tests/unit/daytona-image-version.test.ts fails the',
    ' * suite whenever this checked-in copy is stale.',
    ' */',
    `export const EVOLVE_IMAGE_VERSION = ${quote}${version}${quote}${semi}`,
    '',
  ].join('\n')
}

const TARGETS: Array<{ path: string; quote: "'" | '"' }> = [
  { path: 'assets/docker/image-version.ts', quote: "'" },
  { path: 'packages/modal/src/image-version.ts', quote: '"' },
  { path: 'packages/daytona/src/image-version.ts', quote: '"' },
]

/** Derive the version and rewrite the generated files. Returns what happened. */
export function generateImageVersion(): { version: string; changed: string[] } {
  const version = deriveImageVersion()
  const changed: string[] = []
  for (const { path, quote } of TARGETS) {
    const abs = resolve(REPO_ROOT, path)
    const next = generatedSource(version, quote)
    let current: string | undefined
    try {
      current = readFileSync(abs, 'utf-8')
    } catch {
      current = undefined
    }
    if (current !== next) {
      writeFileSync(abs, next)
      changed.push(path)
    }
  }
  return { version, changed }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, changed } = generateImageVersion()
  console.log(`Derived image version: ${version}`)
  if (changed.length === 0) {
    console.log('All generated constants already fresh.')
  } else {
    for (const path of changed) console.log(`  rewrote ${path}`)
  }
}
