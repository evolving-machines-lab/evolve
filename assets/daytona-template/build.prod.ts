import { config } from 'dotenv'
import { Daytona } from '@daytonaio/sdk'
import { image } from './template'

config({ path: '../../.env' })

async function main() {
  const daytona = new Daytona()

  console.log('Building evolve-all snapshot...')

  await daytona.snapshot.create(
    {
      name: 'evolve-all',
      image,
    },
    {
      onLogs: (log) => console.log(log),
    }
  )

  console.log('Snapshot evolve-all created successfully!')
}

main().catch(console.error)
