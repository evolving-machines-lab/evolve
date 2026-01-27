# Evolve Assets

Sandbox images and templates for all providers.

## E2B

Public template - **no setup needed**. Works out of the box.

```bash
# Only for maintainers (rebuild template)
./build.sh e2b
```

## Modal

Run once to cache the image in your Modal account:

```bash
./build.sh modal
```

**Prerequisites:** `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` in `.env`

## Daytona

Run once to create a snapshot in your Daytona account:

```bash
./build.sh daytona
```

**Prerequisites:** `DAYTONA_API_KEY` in `.env`

## Docker (Maintainers Only)

Build and push the shared Docker image used by Modal + Daytona:

```bash
./build.sh docker
```

## Structure

```
assets/
├── build.sh         # Single entry point
├── docker/          # Shared Dockerfile (Modal + Daytona)
├── modal/           # Modal image caching
├── daytona/         # Daytona snapshot creation
└── e2b-template/    # E2B template (separate build system)
```

## Image Contents

All providers use `evolvingmachines/evolve-all:latest`:

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from this repo
- Python 3.12 + ML packages
- Node.js + npm
