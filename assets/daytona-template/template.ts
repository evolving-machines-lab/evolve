import { Image } from '@daytonaio/sdk'

// =============================================================================
// Evolve Daytona Snapshot (Lightweight)
// =============================================================================
// Creates a snapshot from our public Docker image which includes:
//   - Python 3.12 + essential packages (pandas, numpy, matplotlib, requests, etc.)
//   - Node.js 20
//   - Claude Code, Codex, Gemini CLI, Qwen Code
//   - ACP adapters for Claude and Codex
//   - Google Chrome + Playwright for browser automation
//   - Skills cloned from github.com/evolving-machines-lab/evolve
//
// Does NOT include heavy ML libraries (tensorflow, pytorch) to keep image ~5GB.
//
// The Docker image is built separately and pushed to Docker Hub.
// This template just creates a Daytona snapshot from that image.
//
// To rebuild:
//   1. First push Docker image: cd assets/daytona-template && docker build && docker push
//   2. Then create snapshot: ./build.sh
// =============================================================================

export const image = Image.base('evolvingmachines/evolve-all:latest')
  .workdir('/home/user')
  .cmd(['/bin/bash'])
