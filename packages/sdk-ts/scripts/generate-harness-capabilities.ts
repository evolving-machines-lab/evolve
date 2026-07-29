#!/usr/bin/env tsx
/**
 * Generates harness-capabilities.json — the cross-repo parity artifact for
 * per-harness models and reasoning efforts — from src/registry.ts.
 *
 * OWNER RULING BEHIND THIS FILE: managed EVALS and managed AGENTS must
 * advertise and support the SAME models and efforts. The AGENT_REGISTRY table
 * in registry.ts is the single source of truth; this script projects it into a
 * checked-in JSON file that the hosted-evals dashboard consumes for its public
 * capability document (GET /api/meta), because the two repos share no test
 * runner and the dashboard must never re-type these tables by hand.
 *
 * Same pattern as hosted-error-codes.json (the artifact beside this one),
 * with the ownership arrow reversed: error codes are owned by the server and
 * shadowed here; models/efforts are owned HERE and shadowed by the server.
 *
 * Usage:
 *   tsx scripts/generate-harness-capabilities.ts          # write the artifact
 *   tsx scripts/generate-harness-capabilities.ts --check  # fail if stale (build runs this)
 *
 * Who checks what, so no copy goes unread:
 *   - this script --check (wired into `npm run build`): artifact bytes vs registry.ts
 *   - tests/unit/harness-capabilities.test.ts: same diff + artifact invariants
 *   - packages/sdk-py/tests/unit/test_harness_capabilities.py: Python's
 *     AgentType/ReasoningEffort Literals cover the artifact
 *   - dashboard __tests__/lib/evaluations-capability-parity.test.ts: the SERVED
 *     capability document equals the artifact
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  AGENT_REGISTRY,
  BINARY_EFFORT_VALUES,
  DEFAULT_REASONING_EFFORT,
  harnessEffortVocabulary,
  REASONING_EFFORTS,
} from "../src/registry";

const ARTIFACT_COMMENT =
  "Per-harness models and reasoning efforts, checked in so two repos that share no test runner can be held to one table. " +
  "The evolve SDK owns it: AGENT_REGISTRY in packages/sdk-ts/src/registry.ts is the only place models, efforts, or defaults may change, " +
  "and scripts/generate-harness-capabilities.ts regenerates this file from it (npm run generate:capabilities; the build fails when it is stale). " +
  "The hosted-evals dashboard consumes this file for its capability document and its parity test diffs the served document against it, " +
  "the TypeScript SDK test regenerates these exact bytes from the registry, and the Python SDK test asserts its own Literals cover them. " +
  "Changing a model or an effort therefore means: registry.ts, regenerate this file, and nothing else.";

/** One model as advertised: the ModelInfo fields that are data, not behavior. */
type ArtifactModel = {
  alias: string;
  modelId: string;
  description: string;
  maxContextSize?: number;
};

export type HarnessCapabilitiesArtifact = {
  $comment: string;
  /** Full graded vocabulary `reasoningEffort` accepts, in ascending order of thinking. */
  reasoningEfforts: string[];
  /** The subset a 'binary' harness can honestly represent. */
  binaryEffortValues: string[];
  /** Effort a run takes when it names none (harnesses with effortSupport 'none' take none at all). */
  defaultReasoningEffort: string;
  harnesses: Record<
    string,
    {
      defaultModel: string;
      models: ArtifactModel[];
      effortSupport: "level" | "binary" | "none";
      efforts: string[];
      defaultEffort: string | null;
    }
  >;
};

export function buildHarnessCapabilitiesArtifact(): HarnessCapabilitiesArtifact {
  const harnesses: HarnessCapabilitiesArtifact["harnesses"] = {};
  // Sorted so the artifact's bytes are stable regardless of registry entry order.
  for (const name of Object.keys(AGENT_REGISTRY).sort()) {
    const entry = AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY];
    const vocabulary = harnessEffortVocabulary(entry.effortSupport);
    harnesses[name] = {
      defaultModel: entry.defaultModel,
      models: entry.models.map((model) => ({
        alias: model.alias,
        modelId: model.modelId,
        description: model.description,
        // JSON.stringify drops undefined, so absent stays absent.
        maxContextSize: model.maxContextSize,
      })),
      effortSupport: entry.effortSupport,
      efforts: [...vocabulary.efforts],
      // The harness's own pinned default is the truth; the vocabulary-level
      // default is only the fallback for entries that pin nothing.
      defaultEffort: entry.defaultReasoningEffort ?? vocabulary.defaultEffort,
    };
  }
  return {
    $comment: ARTIFACT_COMMENT,
    reasoningEfforts: [...REASONING_EFFORTS],
    binaryEffortValues: [...BINARY_EFFORT_VALUES],
    defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
    harnesses,
  };
}

/** The artifact's exact bytes — one renderer, so every checker diffs the same string. */
export function renderHarnessCapabilitiesJson(): string {
  return JSON.stringify(buildHarnessCapabilitiesArtifact(), null, 2) + "\n";
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARTIFACT_PATH = join(PACKAGE_ROOT, "harness-capabilities.json");

function main(): void {
  const expected = renderHarnessCapabilitiesJson();
  if (process.argv.includes("--check")) {
    let onDisk: string | null = null;
    try {
      onDisk = readFileSync(ARTIFACT_PATH, "utf8");
    } catch {
      // fall through to the stale message below
    }
    if (onDisk !== expected) {
      console.error(
        "harness-capabilities.json is stale: src/registry.ts changed without regenerating it.\n" +
          "Run: npm run generate:capabilities  (in packages/sdk-ts) and commit the result.",
      );
      process.exit(1);
    }
    console.log("harness-capabilities.json matches src/registry.ts");
    return;
  }
  writeFileSync(ARTIFACT_PATH, expected);
  console.log(`wrote ${ARTIFACT_PATH}`);
}

// Only run as a CLI; the test imports the builders without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
