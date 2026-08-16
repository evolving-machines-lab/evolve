/**
 * Create a Daytona snapshot from the public Evolve image for fast sandbox startup.
 *
 * Usage: npx tsx build.ts
 *
 * Prerequisites:
 *   - DAYTONA_API_KEY in .env or environment
 */

import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Daytona } from '@daytonaio/sdk'
import { image, SNAPSHOT_NAME, SNAPSHOT_RESOURCES } from './template'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../.env') })

async function deleteExistingSnapshot(daytona: Daytona): Promise<void> {
  try {
    const snapshot = await daytona.snapshot.get(SNAPSHOT_NAME)
    console.log(`  Found existing snapshot "${snapshot.name}" (${snapshot.state})`)
    console.log('  Deleting...')
    await daytona.snapshot.delete(snapshot)

    // Poll until snapshot is actually gone
    process.stdout.write('  Waiting')
    while (true) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        await daytona.snapshot.get(SNAPSHOT_NAME)
        process.stdout.write('.')
      } catch {
        console.log(' done')
        break
      }
    }
  } catch {
    // Snapshot doesn't exist, nothing to delete
  }
}

async function main() {
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Daytona Snapshot Builder       ║')
  console.log('╚════════════════════════════════════════╝')
  console.log(`\nSnapshot: ${SNAPSHOT_NAME}`)

  // useDeprecatedPolling: since 0.203 the bare constructor eagerly opens a
  // socket.io WebSocket for lifecycle events. Nothing here consumes events,
  // and the open socket would keep this one-shot script's event loop alive
  // after the build finishes — it would never exit. Same flag, same reason,
  // as packages/daytona.
  const daytona = new Daytona({ useDeprecatedPolling: true })

  // Delete existing snapshot if present
  await deleteExistingSnapshot(daytona)

  // Create new snapshot
  console.log(`\n▸ Creating snapshot "${SNAPSHOT_NAME}"...`)
  console.log('  (This may take 2-3 minutes on first run)\n')

  await daytona.snapshot.create(
    {
      name: SNAPSHOT_NAME,
      image,
      resources: { ...SNAPSHOT_RESOURCES },
    },
    {
      onLogs: (log) => console.log(`  ${log}`),
    }
  )

  console.log(`\n✓ Done! Snapshot "${SNAPSHOT_NAME}" created.`)
  console.log('  Subsequent sandbox creations will be instant.')
}

// Exit NON-ZERO on failure. `catch(console.error)` printed the error and then
// exited 0, so a failed build reported success to every caller — including CI.
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
