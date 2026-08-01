/**
 * Evolve Daytona image reference.
 * Public Docker image used to create snapshots.
 *
 * Versioned name + tag from assets/docker/image-version.ts: Daytona caches
 * snapshots by name, so only a per-release snapshot name makes updates reach
 * users. The provider auto-creates this snapshot on first use; this builder
 * exists to pre-build it.
 */
import { Image } from '@daytonaio/sdk'
import { EVOLVE_IMAGE_VERSION } from '../docker/image-version'

export const image = Image.base(`evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`)
export const SNAPSHOT_NAME = `evolve-all-${EVOLVE_IMAGE_VERSION}`
