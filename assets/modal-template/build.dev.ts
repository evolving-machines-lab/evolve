import { config } from 'dotenv'
import { ModalClient } from 'modal'
import { EVOLVE_IMAGE } from './template'

config({ path: '../../.env' })

async function main() {
  console.log('Building Modal image for evolve-all-dev...')
  console.log(`Image: ${EVOLVE_IMAGE}`)

  const modal = new ModalClient()
  const app = await modal.apps.fromName('evolve-all-dev', { createIfMissing: true })

  console.log('Triggering image build (this may take a while on first run)...')
  const startTime = Date.now()

  // Use documented .build(app) method to eagerly pull and cache image
  const image = await modal.images.fromRegistry(EVOLVE_IMAGE).build(app)
  console.log(`Image ID: ${image.imageId}`)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`Done! Image built in ${elapsed}s`)
  console.log('Subsequent sandbox creations will be fast.')
}

main().catch(console.error)
