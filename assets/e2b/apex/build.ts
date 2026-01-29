import { config } from 'dotenv'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { Template, defaultBuildLogger } from 'e2b'
import { template } from './template'

const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../../.env') })  // 3 levels up from assets/e2b/apex/

async function main() {
  console.log('Building APEX Benchmark E2B template...')
  console.log('This will take a while due to ~9GB of world data download.')
  console.log('')

  await Template.build(template, {
    alias: 'apex-benchmark',
    cpuCount: 4,
    memoryMB: 8192,  // More memory for LibreOffice + data processing
    skipCache: true,
    onBuildLogs: defaultBuildLogger(),
  })

  console.log('')
  console.log('Template built successfully: apex-benchmark')
}

main().catch(console.error)
