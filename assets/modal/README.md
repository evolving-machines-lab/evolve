# Modal

Cache the Evolve image in your Modal account for fast sandbox startup.

## Setup

1. Get tokens from [modal.com/settings/tokens](https://modal.com/settings/tokens)

2. Add to `.env` in **repo root** (not assets/):
   ```bash
   MODAL_TOKEN_ID=ak-...
   MODAL_TOKEN_SECRET=as-...
   ```

3. Cache the image (one-time):
   ```bash
   cd assets && ./build.sh modal
   ```

After caching, all sandbox creations will be instant.

## Image

Uses public Docker image: `evolvingmachines/evolve-all:latest`
