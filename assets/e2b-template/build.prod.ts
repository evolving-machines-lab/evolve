import { config } from 'dotenv'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

config({ path: '../../.env' })

async function main() {
  await Template.build(template, {
    alias: 'evolve-all',
    cpuCount: 4,
    memoryMB: 4096,
    skipCache: true,
    onBuildLogs: defaultBuildLogger(),
  })
}

main().catch(console.error)
