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

/** The immutable release ref every snapshot below is built from. */
export const EVOLVE_IMAGE_REF = `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`

export const image = Image.base(EVOLVE_IMAGE_REF)
export const SNAPSHOT_NAME = `evolve-all-${EVOLVE_IMAGE_VERSION}`

/**
 * Sizing every Evolve snapshot is built with. One constant because two
 * builders create snapshots now — ./build.ts and
 * ./refresh-platform-snapshot.ts — and a snapshot that differs in sizing from
 * the one it replaces is a silent change to what users get.
 */
export const SNAPSHOT_RESOURCES = { cpu: 4, memory: 4, disk: 10 } as const
