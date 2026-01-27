// =============================================================================
// Evolve Modal Image
// =============================================================================
// Uses the same Docker image as Daytona and E2B templates:
//   evolvingmachines/evolve-all:latest
//
// Based on e2bdev/code-interpreter:latest for 100% parity with E2B.
//
// Includes:
//   - Python 3.12 + ML/science packages (numpy, pandas, scikit-learn, scipy, etc.)
//   - Node.js
//   - Claude Code, Codex, Gemini CLI, Qwen Code + ACP adapters
//   - Google Chrome + Playwright for browser automation
//   - Skills from github.com/evolving-machines-lab/evolve
//
// The Docker image is built from ../daytona-template/Dockerfile
// Any Modal user can use this image via fromRegistry().
// =============================================================================

/**
 * Evolve image name on Docker Hub.
 * Public - any Modal user can use this.
 */
export const EVOLVE_IMAGE = 'evolvingmachines/evolve-all:latest'

/**
 * Example usage in Modal TypeScript SDK:
 *
 * ```typescript
 * import { ModalClient } from 'modal'
 * import { EVOLVE_IMAGE } from './template'
 *
 * const modal = new ModalClient()
 * const app = await modal.apps.fromName('my-app', { createIfMissing: true })
 * const image = modal.images.fromRegistry(EVOLVE_IMAGE)
 *
 * const sb = await modal.sandboxes.create(app, image, {
 *   timeout: 3600000,
 *   workdir: '/home/user',
 *   secrets: [modal.secrets.fromObject({
 *     ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
 *   })],
 * })
 *
 * // Run claude code
 * const p = await sb.exec(['claude', '--version'])
 * console.log(await p.stdout.readText())
 *
 * await sb.terminate()
 * ```
 */
