#!/bin/bash

# Evolve SDK E2B Template Builder
# Usage: ./build.sh [dev|prod]
#   dev  - builds evolve-all-dev
#   prod - builds evolve-all (default)

cd "$(dirname "$0")"

ENV="${1:-prod}"

if [ "$ENV" = "dev" ]; then
  npx tsx build.dev.ts
else
  npx tsx build.prod.ts
fi
