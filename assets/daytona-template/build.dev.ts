import { config } from 'dotenv'
import { Daytona } from '@daytonaio/sdk'
import { image } from './template'

config({ path: '../../.env' })

const SNAPSHOT_NAME = 'evolve-all-dev'

async function deleteExistingSnapshot(daytona: Daytona): Promise<void> {
  try {
    const snapshot = await daytona.snapshot.get(SNAPSHOT_NAME)
    console.log(`Found existing snapshot "${snapshot.name}" (${snapshot.state})`)
    console.log('Deleting...')
    await daytona.snapshot.delete(snapshot)
    console.log('Waiting for deletion to propagate...')

    // Poll until snapshot is actually gone
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
  console.log('║  Evolve Daytona Template Builder (Dev) ║')
  console.log('╚════════════════════════════════════════╝')

  const daytona = new Daytona()

  // Delete existing snapshot if present
  await deleteExistingSnapshot(daytona)

  // Create new snapshot
  console.log(`\n▸ Creating Daytona snapshot "${SNAPSHOT_NAME}"...`)

  await daytona.snapshot.create(
    {
      name: SNAPSHOT_NAME,
      image,
      resources: {
        cpu: 4,
        memory: 4,
        disk: 10,
      },
    },
    {
      onLogs: (log) => console.log(log),
    }
  )

  console.log(`\n✓ Done! Snapshot "${SNAPSHOT_NAME}" created successfully.`)
}

main().catch(console.error)
