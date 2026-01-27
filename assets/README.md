# Evolve Assets

Sandbox images and templates for E2B, Modal, and Daytona providers.

## For Users

Cache the Evolve image in your provider for fast sandbox startup:

```bash
# Modal
./build.sh modal

# Daytona
./build.sh daytona
```

**E2B** uses a public template - no setup needed.

## For Maintainers

Build and push the Docker image (used by Modal + Daytona):

```bash
./build.sh docker
```

Rebuild E2B template:

```bash
./build.sh e2b
```

## Structure

```
assets/
├── docker/          # Shared Dockerfile for Modal + Daytona
├── modal/           # Modal image caching
├── daytona/         # Daytona snapshot creation
├── e2b-template/    # E2B template (separate build system)
└── build.sh         # Single entry point
```

## Image

All providers use `evolvingmachines/evolve-all:latest` which includes:

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from this repo
- Python 3.12 + ML packages
- Node.js + npm
