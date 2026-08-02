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
immutable tag — and the tag is DERIVED, never hand-written: `c-<12hex>`, the
sha256 of the image's build inputs (the Dockerfile plus everything the build
copies in — see `docker/image-digest.ts` for the exact input set). Same
content derives the same tag, so releases are idempotent; any content change
derives a new tag automatically. Nobody bumps a version:

1. Edit `docker/Dockerfile` (or any file the build copies in) and run
   `npm run generate:image-version` from the repo root (it also runs first in
   `npm run build`). It rewrites the three generated constants files — commit
   them with your change:
   - `assets/docker/image-version.ts` (canonical; every asset builder imports it)
   - `packages/modal/src/image-version.ts`
   - `packages/daytona/src/image-version.ts`

   The coherence test in
   `packages/daytona/tests/unit/daytona-image-version.test.ts` recomputes the
   digest, so a Dockerfile change without regeneration fails the suite —
   there is no way to ship a stale constant.

2. Publish. `.github/workflows/publish.yml` verifies the constants are fresh,
   then builds and pushes `evolvingmachines/evolve-all:c-<12hex>` **and**
   `:latest` — skipping the build when the derived tag already exists on
   Docker Hub. The same thing runs by hand with:

   ```bash
   cd assets && ./build.sh docker
   ```

3. Nothing else to run for users: both providers default to the derived name
   (`evolve-all-c-<12hex>` is Modal's default image name and Daytona's
   default snapshot name), so Modal pulls the new tag on its next create and
   Daytona auto-builds the new snapshot on first use. Callers who pinned a
   name explicitly (for example `evolve-all`) keep exactly what they pinned,
   on both providers. Managed Daytona is separate: it names the platform's
   stable `evolve-all` snapshot, and which release backs that name is the
   platform's decision, not this pipeline's.

4. Rebuild the E2B template (E2B is not part of this law — its public
   template is rebuilt in place):

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

All providers use `evolvingmachines/evolve-all:c-<12hex>` (derived from the
build inputs — see `assets/docker/image-version.ts`; also pushed as `:latest`):

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from this repo
- Python 3.12 + ML packages
- Node.js + npm
