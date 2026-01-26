import { config } from 'dotenv'
import { execSync } from 'child_process'
import { Daytona } from '@daytonaio/sdk'
import { image } from './template'

config({ path: '../../.env' })

const DOCKER_IMAGE = 'evolvingmachines/evolve-all:latest'
const SNAPSHOT_NAME = 'evolve-all'

// Parse args
const args = process.argv.slice(2)
const skipDocker = args.includes('--skip-docker')

function runCommand(cmd: string, description: string): void {
  console.log(`\n▸ ${description}...`)
  execSync(cmd, { stdio: 'inherit' })
}

async function buildAndPushDocker(): Promise<void> {
  runCommand(
    `docker build --platform=linux/amd64 -t ${DOCKER_IMAGE} .`,
    'Building Docker image'
  )
  runCommand(
    `docker push ${DOCKER_IMAGE}`,
    'Pushing to Docker Hub'
  )
}

async function deleteExistingSnapshot(daytona: Daytona): Promise<void> {
  try {
    const result = await daytona.snapshot.list()
    const existing = result.items.find((s: { name: string }) => s.name === SNAPSHOT_NAME)

    if (existing) {
      console.log(`Found existing snapshot "${SNAPSHOT_NAME}" (${existing.id}), state: ${existing.state}`)
      console.log('Deleting existing snapshot...')

      const apiKey = process.env.DAYTONA_API_KEY
      const response = await fetch(`https://api.daytona.io/v1/snapshots/${existing.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        redirect: 'manual',
      })

      if (response.status === 200 || response.status === 204) {
        console.log('Deleted! Waiting 10s...')
        await new Promise(r => setTimeout(r, 10000))
      }
    }
  } catch (error: any) {
    console.log('Note: Could not delete existing snapshot:', error.message || error)
  }
}

async function createSnapshot(daytona: Daytona): Promise<void> {
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
}

async function main() {
  console.log('╔════════════════════════════════════════╗')
  console.log('║  Evolve Daytona Template Builder       ║')
  console.log('╚════════════════════════════════════════╝')

  // Step 1: Docker build & push
  if (skipDocker) {
    console.log('\n⏭  Skipping Docker build (--skip-docker)')
  } else {
    await buildAndPushDocker()
  }

  // Step 2: Daytona snapshot
  const daytona = new Daytona()
  await deleteExistingSnapshot(daytona)
  await createSnapshot(daytona)

  console.log('\n✓ Done! Snapshot "evolve-all" created successfully.')
}

main().catch(console.error)
