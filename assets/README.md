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

### Shipping a new image release

Modal caches images by reference and Daytona caches snapshots by name, so a
re-pushed `:latest` never reaches them. Each release therefore carries an
immutable version tag, held in one constant per file with a law comment tying
the copies together:

1. Bump `EVOLVE_IMAGE_VERSION` (e.g. `v1` → `v2`) in all three places — the
   coherence test in `packages/daytona/tests/unit/daytona-image-version.test.ts`
   fails until they agree:
   - `assets/docker/image-version.ts` (canonical)
   - `packages/modal/src/index.ts`
   - `packages/daytona/src/index.ts`

2. Build and push — this pushes `evolvingmachines/evolve-all:vN` **and**
   `:latest`:

   ```bash
   cd assets && ./build.sh docker
   ```

3. Nothing else to run for users: Modal resolves `evolve-all` to the new
   `:vN` reference on their next create, and Daytona auto-builds the new
   `evolve-all-vN` snapshot on first use. Callers who pinned a name
   explicitly (for example `evolve-all`) keep exactly what they pinned.

4. Rebuild the E2B template (E2B is not versioned — its public template is
   rebuilt in place):

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

All providers use `evolvingmachines/evolve-all:<vN>` (see
`assets/docker/image-version.ts`; also pushed as `:latest`):

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from this repo
- Python 3.12 + ML packages
- Node.js + npm
