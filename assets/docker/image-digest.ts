/**
 * Content-addressing for the evolve-all image — the derivation behind
 * EVOLVE_IMAGE_VERSION. Nobody hand-writes a version: the release tag is
 * `c-<12hex>`, the sha256 of the image's BUILD INPUTS, so a same-content
 * rebuild maps to the same tag (idempotent releases) and any content change
 * maps to a new tag automatically. Same scheme the platform already uses to
 * content-address eval task images.
 *
 * WHAT COUNTS AS A BUILD INPUT: every file under assets/docker/ — the docker
 * build context, so the Dockerfile plus anything a COPY could pull in —
 * EXCEPT the derivation machinery itself, which never reaches the image:
 *   image-version.ts            the generated OUTPUT (hashing it would be circular)
 *   image-digest.ts             this file
 *   generate-image-version.ts   the generator
 *   build.ts                    push tooling — changes how we push, not what the image holds
 *   README.md                   docs
 * A future COPY'd file dropped anywhere under assets/docker/ joins the hash
 * with no code change.
 *
 * FRAMING (matches the platform's build-context digest): for each regular
 * file, sorted by relative path, fold in a length-framed record — 4-byte
 * big-endian path length, the path bytes, one exec-bit byte, then the file's
 * own sha256 (a fixed 32 bytes) standing in for its content. Self-delimiting
 * fields mean no two distinct input sets can hash alike through a shifted
 * boundary. Symlinks are rejected; the Dockerfile must exist.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const DOCKER_DIR = dirname(fileURLToPath(import.meta.url))

/** Root-level files in assets/docker/ that never reach the image. */
const NON_INPUTS = new Set([
  'image-version.ts',
  'image-digest.ts',
  'generate-image-version.ts',
  'build.ts',
  'README.md',
  '.DS_Store',
])

/** Full sha256 hex over the image's build inputs under `dockerDir`. */
export function imageBuildInputsDigest(dockerDir: string = DOCKER_DIR): string {
  const base = resolve(dockerDir)
  const files: string[] = []
  const walk = (rel: string): void => {
    const abs = rel === '' ? base : base + sep + rel.split('/').join(sep)
    const stat = lstatSync(abs, { throwIfNoEntry: false })
    if (!stat) throw new Error(`Build input path disappeared: ${rel || '.'}`)
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked build input: ${rel}`)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(abs).sort()) {
        const childRel = rel === '' ? entry : `${rel}/${entry}`
        if (NON_INPUTS.has(childRel)) continue
        walk(childRel)
      }
      return
    }
    if (!stat.isFile()) throw new Error(`Build inputs contain a non-regular file: ${rel}`)
    files.push(rel)
  }
  walk('')
  if (!files.includes('Dockerfile')) throw new Error(`No Dockerfile among build inputs in ${base}`)
  const hash = createHash('sha256')
  for (const rel of files) {
    const abs = base + sep + rel.split('/').join(sep)
    const stat = lstatSync(abs)
    const relBytes = Buffer.from(rel, 'utf8')
    const relLen = Buffer.alloc(4)
    relLen.writeUInt32BE(relBytes.length)
    hash.update(relLen).update(relBytes)
    hash.update(Buffer.from([(stat.mode & 0o111) !== 0 ? 1 : 0]))
    hash.update(createHash('sha256').update(readFileSync(abs)).digest())
  }
  return hash.digest('hex')
}

/** The shape every derived version satisfies. */
export const EVOLVE_IMAGE_VERSION_PATTERN = /^c-[0-9a-f]{12}$/

/** The derived release version: `c-` + the first 12 hex of the inputs digest. */
export function deriveImageVersion(dockerDir: string = DOCKER_DIR): string {
  return `c-${imageBuildInputsDigest(dockerDir).slice(0, 12)}`
}
