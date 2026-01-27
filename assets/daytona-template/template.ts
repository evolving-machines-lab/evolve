import { Image } from '@daytonaio/sdk'

// =============================================================================
// Evolve Daytona Snapshot
// =============================================================================
// Creates a snapshot from our public Docker image (evolvingmachines/evolve-all)
// which is based on e2bdev/code-interpreter:latest for 100% parity with E2B.
//
// Includes:
//   - Python 3.12 + ML/science packages (numpy, pandas, scikit-learn, scipy, etc.)
//   - Node.js
//   - Claude Code, Codex, Gemini CLI, Qwen Code + ACP adapters
//   - Google Chrome + Playwright for browser automation
//   - Skills from github.com/evolving-machines-lab/evolve
//
// The Docker image is built and pushed via: ./build.sh
// =============================================================================

export const image = Image.base('evolvingmachines/evolve-all:latest')
