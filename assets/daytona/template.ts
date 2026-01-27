/**
 * Evolve Daytona image reference.
 * Public Docker image used to create snapshots.
 */
import { Image } from '@daytonaio/sdk'

export const image = Image.base('evolvingmachines/evolve-all:latest')
export const SNAPSHOT_NAME = 'evolve-all'
