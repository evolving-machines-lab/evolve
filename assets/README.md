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
   on both providers.

4. Rebuild the E2B template (E2B is not part of this law — its public
   template is rebuilt in place):

   ```bash
   cd assets && ./build.sh e2b
   ```

Steps 2–4 are automated. See below.

---

### The automated pipeline

`.github/workflows/image-refresh.yml` takes a change to the image all the way
to users with no manual step. It runs on a push to `main` touching
`assets/docker/**` or `assets/e2b/**`, on a weekly cron, and on manual dispatch.

It pushes the derived tag to Docker Hub (via `docker/build.ts`, so the tag and
push rules stay in one place), rebuilds the E2B template, repoints managed
Daytona, and — when the derived tag moved — opens a PR with the regenerated
constants.

**Who is moved, and when.** The four consumers do not travel together, and this
is the part worth knowing before you wait on the wrong thing:

| Consumer | Moves when | Needs a release? |
|---|---|---|
| E2B | the workflow finishes | no — the `evolve-all` alias is rebuilt in place |
| Managed Daytona | the workflow finishes | no — the platform snapshot is repointed |
| Direct Daytona | the next npm release | yes — its default snapshot name is a compiled-in constant |
| Modal | the next npm release | yes — same constant |

The workflow pre-builds the versioned Daytona snapshot `evolve-all-c-<12hex>`,
so direct users get a warm snapshot rather than paying a build on first use.

**`force_refresh`.** Content addressing cannot see that `@latest` moved
upstream: the Dockerfile text is unchanged, so the tag is unchanged, so the
release is correctly skipped — and new CLI versions never ship. Run the
workflow with `force_refresh: true` to rewrite `docker/refresh-stamp`, an
ordinary build input that the Dockerfile COPYs to `/etc/evolve-image-refresh`.
The stamp is real image content, so the new tag it derives is honest rather
than a nudged hash. By hand, the same thing:

```bash
npx tsx assets/docker/write-refresh-stamp.ts "picking up today's CLI releases"
npm run generate:image-version
```

The weekly cron deliberately does **not** bump the stamp — re-pushing an
immutable tag with different content is exactly what content addressing exists
to prevent. It rebuilds the E2B template (which reinstalls the `@latest` CLIs,
so E2B users do get newer tools) and heals snapshot drift, such as a snapshot
Daytona deactivated after two idle weeks.

**The managed Daytona swap.** Daytona has no rename and no in-place update for
a snapshot ([daytonaio/daytona#2661][d2661], open), so the stable `evolve-all`
name can only be moved by delete-then-create, and there is a real window where
a managed create would fail. `daytona/refresh-platform-snapshot.ts` makes that
window as survivable as the API allows: it builds the versioned snapshot first
and refuses to continue unless it goes active (proving the image works in this
org before anything live is deleted), does nothing when the snapshot already
serves the target image, preserves the replaced snapshot's sizing and
entrypoint, and rolls the name back to the previous image if the rebuild fails.
Deleting a snapshot also destroys its warm pools, so the first managed creates
after a swap pay a cold start. Run it with `--dry-run` to see what it would do:

```bash
npx tsx assets/daytona/refresh-platform-snapshot.ts --dry-run
```

[d2661]: https://github.com/daytonaio/daytona/issues/2661

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
