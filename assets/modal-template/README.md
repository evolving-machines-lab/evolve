# Modal Template

Evolve SDK Modal image configuration.

## Setup

1. **Get Modal tokens** from [modal.com/settings/tokens](https://modal.com/settings/tokens)

2. **Add to `.env`:**
   ```bash
   MODAL_TOKEN_ID=ak_xxxxxxxx
   MODAL_TOKEN_SECRET=as_xxxxxxxx
   ```

3. **Build the image** (one-time, ~30-60s):
   ```bash
   ./build.sh           # builds image for evolve-all (prod)
   ./build.sh dev       # builds image for evolve-all-dev
   ```

After building, all sandbox creations will be fast (~seconds).

## Image

- **Image**: `evolvingmachines/evolve-all:latest` (Docker Hub - public)
- **Base**: `e2bdev/code-interpreter:latest` (Python 3.12 + ML packages)

## Included

- Claude Code + ACP adapter
- Codex + ACP adapter
- Gemini CLI + Nano Banana extension
- Qwen Code
- Google Chrome + Playwright
- mcp-remote, agent-browser
- UV package manager
- Skills from `evolving-machines-lab/evolve`

## Usage

```typescript
import { ModalClient } from 'modal'

const modal = new ModalClient()
const app = await modal.apps.fromName('evolve-sandbox', { createIfMissing: true })
const image = modal.images.fromRegistry('evolvingmachines/evolve-all:latest')

const sb = await modal.sandboxes.create(app, image, {
  timeout: 3600000,
  workdir: '/home/user',
  secrets: [modal.secrets.fromObject({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  })],
})

const p = await sb.exec(['claude', '--version'])
console.log(await p.stdout.readText())

await sb.terminate()
```

## Building the Docker Image

The Docker image is shared with Daytona (`../daytona-template/Dockerfile`):

```bash
cd ../daytona-template
docker build --platform=linux/amd64 -t evolvingmachines/evolve-all:latest .
docker push evolvingmachines/evolve-all:latest
```

## Update Workflow

| Change | Action |
|--------|--------|
| Update CLIs | Edit `../daytona-template/Dockerfile` → rebuild & push → `./build.sh` |
| Add skills | Push to `skills/` in repo → rebuild & push → `./build.sh` |
