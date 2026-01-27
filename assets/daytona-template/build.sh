#!/bin/bash

# Evolve SDK Daytona Snapshot Builder
# Usage:
#   ./build.sh              # Full build: Docker + push + snapshot
#   ./build.sh --skip-docker # Just Daytona snapshot (skip Docker)
#   ./build.sh dev          # Dev snapshot only

cd "$(dirname "$0")"

if [ "$1" = "dev" ]; then
  npx tsx build.dev.ts
else
  npx tsx build.prod.ts "$@"
fi
