import { config } from 'dotenv'
import { Daytona } from '@daytonaio/sdk'
import { image } from './template'

config({ path: '../../.env' })

async function main() {
  const daytona = new Daytona()

  console.log('Building evolve-all-dev snapshot...')

  await daytona.snapshot.create(
    {
      name: 'evolve-all-dev',
      image,
    },
    {
      onLogs: (log) => console.log(log),
    }
  )

  console.log('Snapshot evolve-all-dev created successfully!')
}

main().catch(console.error)
