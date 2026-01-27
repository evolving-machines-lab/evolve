# Daytona Template

Evolve SDK Daytona snapshot with all AI coding CLIs pre-installed.

## Base Image

`e2bdev/code-interpreter:latest` - same as E2B for 100% parity.

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

```bash
./build.sh                  # Docker build + push + Daytona snapshot
./build.sh --skip-docker    # Just Daytona snapshot (skip Docker)
./build.sh dev              # Dev snapshot
```

The build script:
1. Builds Docker image (`evolvingmachines/evolve-all:latest`)
2. Pushes to Docker Hub
3. Creates Daytona snapshot from the image

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Docker image definition |
| `template.ts` | Daytona Image reference |
| `build.prod.ts` | Full build script (Docker + Daytona) |
| `build.dev.ts` | Dev snapshot build |
| `build.sh` | Shell wrapper |

## Public Image

Docker Hub: `evolvingmachines/evolve-all:latest`

Anyone can use this image directly. The Daytona snapshot is org-private but uses the public image.

## Prerequisites

- `DAYTONA_API_KEY` environment variable
- Docker (logged into Docker Hub)
- Node.js 18+
