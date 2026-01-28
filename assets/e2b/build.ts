import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../.env') })

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
