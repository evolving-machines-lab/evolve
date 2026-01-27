# Daytona

Create a snapshot in your Daytona account for fast sandbox startup.

## Setup

1. Get API key from [app.daytona.io/dashboard/keys](https://app.daytona.io/dashboard/keys)

2. Add to `.env`:
   ```bash
   DAYTONA_API_KEY=...
   ```

3. Create snapshot (one-time):
   ```bash
   cd assets && ./build.sh daytona
   ```

After creating the snapshot, all sandbox creations will be fast (~seconds).

## Image

Uses public Docker image: `evolvingmachines/evolve-all:latest`
