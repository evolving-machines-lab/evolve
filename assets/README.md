# Evolve Assets

Sandbox images and templates for all providers.

## Quick Start

**E2B** — Works out of the box. No setup needed.

**Modal** or **Daytona** — One-time setup required (see below).

---

## Setup for Modal

1. Get tokens from [modal.com/settings/tokens](https://modal.com/settings/tokens)

2. Add to `.env` in **repo root**:
   ```bash
   MODAL_TOKEN_ID=ak-...
   MODAL_TOKEN_SECRET=as-...
   ```

3. Cache the image (run once):
   ```bash
   cd assets && ./build.sh modal
   ```

After this, Modal sandbox creation will be instant.

---

## Setup for Daytona

1. Get API key from [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys)

2. Add to `.env` in **repo root**:
   ```bash
   DAYTONA_API_KEY=...
   ```

3. Create snapshot (run once):
   ```bash
   cd assets && ./build.sh daytona
   ```

After this, Daytona sandbox creation will be instant.

---

## For Maintainers Only

Rebuild the shared Docker image (Modal + Daytona use this):

```bash
cd assets && ./build.sh docker
```

Rebuild the E2B template:

```bash
cd assets && ./build.sh e2b
```

---

## Structure

```
assets/
├── build.sh         # Single entry point for all commands
├── docker/          # Shared Dockerfile (maintainer only)
├── modal/           # Modal image caching
├── daytona/         # Daytona snapshot creation
└── e2b/             # E2B template (public, maintainer only)
```

## Image Contents

All providers use `evolvingmachines/evolve-all:latest`:

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from this repo
- Python 3.12 + ML packages
- Node.js + npm
