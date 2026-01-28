/**
 * Cache the Evolve image in your Modal account for fast sandbox startup.
 *
 * Usage: npx tsx build.ts
 *
 * Prerequisites:
 *   - MODAL_TOKEN_ID and MODAL_TOKEN_SECRET in .env or environment
 */

import { config } from 'dotenv'
import { ModalClient } from 'modal'
import { EVOLVE_IMAGE } from './template'

config({ path: '../../.env' })

async function main() {
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Modal Image Cache              ║')
  console.log('╚════════════════════════════════════════╝')
  console.log(`\nImage: ${EVOLVE_IMAGE}`)

  const modal = new ModalClient()
  const app = await modal.apps.fromName('evolve-sandbox', { createIfMissing: true })

  console.log('\n▸ Caching image (this may take a while on first run)...')
  const startTime = Date.now()

  // forceBuild ensures we always pull the latest image from Docker Hub
  const image = await modal.images
    .fromRegistry(EVOLVE_IMAGE)
    .dockerfileCommands([], { forceBuild: true })
    .build(app)
  console.log(`  Image ID: ${image.imageId}`)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n✓ Done! Image cached in ${elapsed}s`)
  console.log('  Subsequent sandbox creations will be instant.')
}

main().catch(console.error)
