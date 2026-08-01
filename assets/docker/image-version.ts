/**
 * The Evolve image release — THE number to bump when shipping a new image.
 *
 * LAW — one version, three copies, bumped together in one commit:
 *   assets/docker/image-version.ts   (this file — canonical; every asset
 *                                     builder under assets/ imports it)
 *   packages/modal/src/index.ts      (EVOLVE_IMAGE_VERSION → IMAGE_MAP tag)
 *   packages/daytona/src/index.ts    (EVOLVE_IMAGE_VERSION → default snapshot
 *                                     name + IMAGE_MAP tag)
 * The published packages ship standalone and cannot import this file, so the
 * version is restated there; the coherence test in
 * packages/daytona/tests/unit/daytona-image-version.test.ts fails the suite
 * whenever the three copies disagree.
 *
 * WHY versioned tags at all: Modal caches images by reference and Daytona
 * caches snapshots by name, so a re-pushed mutable :latest reached nobody —
 * their caches kept serving the first pull forever. Each release pushes an
 * immutable :vN alongside :latest, and the providers default to :vN. E2B is
 * deliberately NOT part of this law: its public template is rebuilt in place.
 */
export const EVOLVE_IMAGE_VERSION = 'v1'
