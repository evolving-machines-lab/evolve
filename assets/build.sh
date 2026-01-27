#!/bin/bash

# Evolve Sandbox Setup
# Run once to enable fast sandbox startup.
#
# Usage:
#   ./build.sh e2b       # E2B users
#   ./build.sh modal     # Modal users
#   ./build.sh daytona   # Daytona users
#   ./build.sh docker    # Maintainer: push Docker image

set -e
cd "$(dirname "$0")"

case "$1" in
  e2b)
    echo "Building E2B template..."
    cd e2b-template && npx tsx build.prod.ts
    ;;
  modal)
    echo "Caching image in Modal..."
    npx tsx modal/build.ts
    ;;
  daytona)
    echo "Creating Daytona snapshot..."
    npx tsx daytona/build.ts
    ;;
  docker)
    echo "Building and pushing Docker image..."
    npx tsx docker/build.ts
    ;;
  *)
    echo "Evolve Sandbox Setup"
    echo ""
    echo "Run once to enable fast sandbox startup:"
    echo ""
    echo "  ./build.sh e2b       # E2B users"
    echo "  ./build.sh modal     # Modal users"
    echo "  ./build.sh daytona   # Daytona users"
    exit 1
    ;;
esac
