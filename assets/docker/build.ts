/**
 * Build and push the Evolve Docker image to Docker Hub.
 *
 * Usage: npx tsx build.ts
 *
 * This is for MAINTAINERS only. Users don't need to run this.
 * The image is public at: evolvingmachines/evolve-all:c-<12hex> (+ :latest)
 *
 * The tag is DERIVED, never hand-written: this script regenerates the
 * image-version constants first (see ./generate-image-version.ts), so the
 * pushed tag always matches the build inputs. Every push carries TWO tags:
 * the immutable content tag :c-<12hex> — the one Modal/Daytona defaults
 * actually pull, because both cache by reference/name and would never see a
 * re-pushed :latest — and the mutable :latest for humans and for callers who
 * pinned the bare name.
 *
 * IDEMPOTENT: when the derived tag already exists on Docker Hub the build is
 * skipped — the inputs have not changed, and re-pushing would silently swap
 * an immutable tag's contents (this Dockerfile installs @latest tools from
 * the network, so rebuilds are not bit-identical). :latest is realigned to
 * the content tag server-side so a reverted Dockerfile still leaves :latest
 * pointing at the repo's current content.
 */

import { execSync } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { generateImageVersion } from './generate-image-version'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = 'evolvingmachines/evolve-all'
const LATEST_IMAGE = `${REPO}:latest`

function run(cmd: string, description: string): void {
  console.log(`\n▸ ${description}...`)
  execSync(cmd, { stdio: 'inherit', cwd: __dirname })
}

/** Does the tag already exist on Docker Hub? Fails hard on an unreachable
 * registry — guessing "no" would rebuild and overwrite an immutable tag. */
async function tagExistsOnHub(tag: string): Promise<boolean> {
  const res = await fetch(`https://hub.docker.com/v2/repositories/${REPO}/tags/${tag}`)
  if (res.ok) return true
  if (res.status === 404) return false
  throw new Error(`Docker Hub tag check failed: HTTP ${res.status}`)
}

async function main() {
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Docker Image Builder           ║')
  console.log('╚════════════════════════════════════════╝')

  const { version, changed } = generateImageVersion()
  if (changed.length > 0) {
    console.log(`\nRegenerated stale constants (commit them): ${changed.join(', ')}`)
  }
  const versionedImage = `${REPO}:${version}`
  console.log(`\nImage: ${versionedImage} (+ ${LATEST_IMAGE})`)

  if (await tagExistsOnHub(version)) {
    console.log(`\n✓ ${versionedImage} already on Docker Hub — build inputs unchanged, nothing to build.`)
    run(
      `docker buildx imagetools create -t ${LATEST_IMAGE} ${versionedImage}`,
      `Realigning ${LATEST_IMAGE} to ${versionedImage} (server-side)`
    )
    return
  }

  run(
    `docker build --platform=linux/amd64 --no-cache -t ${versionedImage} -t ${LATEST_IMAGE} .`,
    'Building Docker image (no cache)'
  )

  run(
    `docker push ${versionedImage}`,
    `Pushing ${versionedImage} to Docker Hub`
  )

  run(
    `docker push ${LATEST_IMAGE}`,
    `Pushing ${LATEST_IMAGE} to Docker Hub`
  )

  console.log('\n✓ Done! Image pushed to Docker Hub.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
