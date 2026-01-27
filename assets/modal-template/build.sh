#!/bin/bash

# Evolve SDK Modal Template Builder
# Usage: ./build.sh [dev|prod]
#   dev  - warms cache for evolve-all-dev app
#   prod - warms cache for evolve-all app (default)

cd "$(dirname "$0")"

ENV="${1:-prod}"

if [ "$ENV" = "dev" ]; then
  npx tsx build.dev.ts
else
  npx tsx build.prod.ts
fi
