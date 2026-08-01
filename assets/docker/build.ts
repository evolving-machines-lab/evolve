/**
 * Build and push the Evolve Docker image to Docker Hub.
 *
 * Usage: npx tsx build.ts
 *
 * This is for MAINTAINERS only. Users don't need to run this.
 * The image is public at: evolvingmachines/evolve-all:<vN> (+ :latest)
 *
 * Every push carries TWO tags: the immutable :vN from image-version.ts —
 * the one Modal/Daytona defaults actually pull, because both cache by
 * reference/name and would never see a re-pushed :latest — and the mutable
 * :latest for humans and for callers who pinned the bare name.
 */

import { execSync } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { EVOLVE_IMAGE_VERSION } from './image-version'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VERSIONED_IMAGE = `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`
const LATEST_IMAGE = 'evolvingmachines/evolve-all:latest'

function run(cmd: string, description: string): void {
  console.log(`\n▸ ${description}...`)
  execSync(cmd, { stdio: 'inherit', cwd: __dirname })
}

async function main() {
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Docker Image Builder           ║')
  console.log('╚════════════════════════════════════════╝')
  console.log(`\nImage: ${VERSIONED_IMAGE} (+ ${LATEST_IMAGE})`)

  run(
    `docker build --platform=linux/amd64 --no-cache -t ${VERSIONED_IMAGE} -t ${LATEST_IMAGE} .`,
    'Building Docker image (no cache)'
  )

  run(
    `docker push ${VERSIONED_IMAGE}`,
    `Pushing ${VERSIONED_IMAGE} to Docker Hub`
  )

  run(
    `docker push ${LATEST_IMAGE}`,
    `Pushing ${LATEST_IMAGE} to Docker Hub`
  )

  console.log('\n✓ Done! Image pushed to Docker Hub.')
}

main().catch(console.error)
