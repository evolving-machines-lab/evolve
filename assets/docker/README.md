# Docker Image

Shared Docker image for Modal and Daytona providers.

## For Maintainers Only

Build and push to Docker Hub:

```bash
cd assets && ./build.sh docker
```

Or directly:

```bash
npx tsx build.ts
```

## Image

- **Name:** `evolvingmachines/evolve-all:latest`
- **Base:** `e2bdev/code-interpreter:latest`

## Contents

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from `evolving-machines-lab/evolve`
- Python 3.12 + ML packages
- Node.js + npm
