# Docker Image

Shared Docker image for Modal and Daytona providers.

## For Maintainers Only

Build and push to Docker Hub:

```bash
cd assets && ./build.sh docker
```

Or directly from this folder:

```bash
npx tsx build.ts
```

Normally neither is needed by hand: `.github/workflows/image-refresh.yml` does
this, plus E2B and managed Daytona, on every push to `main` that touches this
folder and again every Monday and Thursday. It also merges the regenerated
constants and cuts the release. See the pipeline section in `../README.md`.

### Forcing a refresh

The tag is derived from this folder's contents, so an unchanged Dockerfile
derives an unchanged tag and the build is correctly skipped — even though the
image installs its tools with `@latest` and would really be different today.
To ship those newer tools, move `refresh-stamp`:

```bash
npx tsx write-refresh-stamp.ts "picking up today's CLI releases"
npm run generate:image-version   # from the repo root
```

The stamp is an ordinary build input and the Dockerfile COPYs it to
`/etc/evolve-image-refresh`, so the new tag describes a genuinely different
image. The workflow does the same thing on every scheduled run, and on manual
dispatch with `force_refresh`.

## Image

- **Name:** `evolvingmachines/evolve-all:c-<12hex>` (+ `:latest`) — the tag is
  derived from the build inputs, never hand-written (see `image-digest.ts`)
- **Base:** `e2bdev/code-interpreter:latest`

## Contents

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from `evolving-machines-lab/evolve`
- Python 3.12 + ML packages
- Node.js + npm
