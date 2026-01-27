/**
 * Build and push the Evolve Docker image to Docker Hub.
 *
 * Usage: npx tsx build.ts
 *
 * This is for MAINTAINERS only. Users don't need to run this.
 * The image is public at: evolvingmachines/evolve-all:latest
 */

import { execSync } from 'child_process'

const DOCKER_IMAGE = 'evolvingmachines/evolve-all:latest'

function run(cmd: string, description: string): void {
  console.log(`\n▸ ${description}...`)
  execSync(cmd, { stdio: 'inherit', cwd: __dirname })
}

async function main() {
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Docker Image Builder           ║')
  console.log('╚════════════════════════════════════════╝')
  console.log(`\nImage: ${DOCKER_IMAGE}`)

  run(
    `docker build --platform=linux/amd64 -t ${DOCKER_IMAGE} .`,
    'Building Docker image'
  )

  run(
    `docker push ${DOCKER_IMAGE}`,
    'Pushing to Docker Hub'
  )

  console.log('\n✓ Done! Image pushed to Docker Hub.')
}

main().catch(console.error)
