#!/bin/bash

# Evolve Assets Builder
#
# Usage:
#   ./build.sh modal     - Cache image in Modal (for users)
#   ./build.sh daytona   - Create Daytona snapshot (for users)
#   ./build.sh docker    - Build & push Docker image (maintainer only)
#   ./build.sh e2b       - Build E2B template (maintainer only)

set -e
cd "$(dirname "$0")"

case "$1" in
  modal)
    echo "Caching Evolve image in Modal..."
    npx tsx modal/build.ts
    ;;
  daytona)
    echo "Creating Evolve snapshot in Daytona..."
    npx tsx daytona/build.ts
    ;;
  docker)
    echo "Building and pushing Docker image (maintainer only)..."
    npx tsx docker/build.ts
    ;;
  e2b)
    echo "Building E2B template (maintainer only)..."
    npx tsx e2b/build.ts
    ;;
  *)
    echo "Evolve Assets Builder"
    echo ""
    echo "Usage: ./build.sh <provider>"
    echo ""
    echo "For users (fast sandbox startup):"
    echo "  modal     Cache image in your Modal account"
    echo "  daytona   Create snapshot in your Daytona account"
    echo ""
    echo "For maintainers:"
    echo "  docker    Build & push Docker image to Hub"
    echo "  e2b       Rebuild E2B template"
    exit 1
    ;;
esac
