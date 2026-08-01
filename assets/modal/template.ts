/**
 * Evolve Modal image reference.
 * Public Docker image - any Modal user can use this.
 *
 * Versioned tag from assets/docker/image-version.ts: Modal caches images by
 * reference, so only an immutable per-release tag makes updates reach users.
 */
import { EVOLVE_IMAGE_VERSION } from '../docker/image-version'

export const EVOLVE_IMAGE = `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`
