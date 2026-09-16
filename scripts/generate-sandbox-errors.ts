/**
 * The generator behind the sandbox-observation mirrors — `npm run
 * generate:sandbox-errors` (repo root).
 *
 * packages/sdk-ts/src/sandbox-errors.ts (the typed refusals) and
 * packages/sdk-ts/src/sandbox-observation.ts (the contract's shared rules for
 * observing files) each have ONE home. The provider packages cannot import the
 * SDK (it depends on them), so each carries a byte-equal copy; this script
 * writes those copies, and packages/sdk-ts/tests/unit/sandbox-errors.test.ts
 * fails the unit suite whenever a copy is stale — the same generated-mirror
 * pattern as assets/docker/generate-image-version.ts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PROVIDER_PACKAGES = ["e2b", "daytona", "modal"] as const;

/** One source of truth and its declared mirrors, all relative to the repo root. */
export interface MirrorSet {
  source: string;
  mirrors: readonly string[];
}

function mirrorSet(file: string): MirrorSet {
  return {
    source: `packages/sdk-ts/src/${file}`,
    mirrors: PROVIDER_PACKAGES.map((pkg) => `packages/${pkg}/src/${file}`),
  };
}

/** Every mirrored file, in generation order. */
export const SANDBOX_MIRROR_SETS: readonly MirrorSet[] = [
  mirrorSet("sandbox-errors.ts"),
  mirrorSet("sandbox-observation.ts"),
];

/** The typed refusals' source and mirrors (kept named for the test that pins them). */
export const SANDBOX_ERRORS_SOURCE = SANDBOX_MIRROR_SETS[0].source;
export const SANDBOX_ERRORS_MIRRORS = SANDBOX_MIRROR_SETS[0].mirrors;

/** Copy every source over its mirrors. Returns the mirrors that changed. */
export function generateSandboxErrors(): string[] {
  const changed: string[] = [];
  for (const { source, mirrors } of SANDBOX_MIRROR_SETS) {
    const text = readFileSync(resolve(REPO_ROOT, source), "utf-8");
    for (const mirror of mirrors) {
      const abs = resolve(REPO_ROOT, mirror);
      let current: string | undefined;
      try {
        current = readFileSync(abs, "utf-8");
      } catch {
        current = undefined;
      }
      if (current !== text) {
        writeFileSync(abs, text);
        changed.push(mirror);
      }
    }
  }
  return changed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = generateSandboxErrors();
  if (changed.length === 0) {
    console.log("All sandbox mirrors already fresh.");
  } else {
    for (const mirror of changed) console.log(`  rewrote ${mirror}`);
  }
}
