#!/usr/bin/env tsx
/**
 * Unit Test: harness-capabilities.json has not drifted from src/registry.ts.
 *
 * OWNER RULING: managed EVALS and managed AGENTS must advertise and support the
 * SAME models and efforts. The artifact is how the hosted-evals dashboard reads
 * this repo's registry tables without retyping them, so a stale artifact means
 * the two products silently advertise different lineups — exactly the failure
 * this file exists to kill.
 *
 * The chain: registry.ts -> harness-capabilities.json (proven HERE, byte for
 * byte) -> dashboard capability document (proven in the dashboard's
 * evaluations-capability-parity test) -> Python Literals (proven in
 * sdk-py's test_harness_capabilities.py). No link is a copy nobody checks.
 *
 * Read from src, not dist: a drift detector that can pass against a stale
 * build is not a detector.
 *
 * Usage:
 *   npm run test:unit:capabilities
 *   npx tsx tests/unit/harness-capabilities.test.ts
 */

import { readFileSync } from "node:fs";

import { AGENT_REGISTRY, REASONING_EFFORTS } from "../../src/registry";
import {
  ARTIFACT_PATH,
  buildHarnessCapabilitiesArtifact,
  renderHarnessCapabilitiesJson,
  type HarnessCapabilitiesArtifact,
} from "../../scripts/generate-harness-capabilities";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

console.log("\n=== Harness-capabilities parity (vs harness-capabilities.json) ===\n");

// --- 1. The checked-in bytes are what the registry regenerates -----------------

const onDisk = readFileSync(ARTIFACT_PATH, "utf8");
const expected = renderHarnessCapabilitiesJson();

if (onDisk === expected) {
  assert(true, "harness-capabilities.json is byte-identical to what registry.ts regenerates");
} else {
  // A paste-able diff, not a boolean: name the first line where they part ways.
  const onDiskLines = onDisk.split("\n");
  const expectedLines = expected.split("\n");
  let line = 0;
  while (line < Math.max(onDiskLines.length, expectedLines.length) && onDiskLines[line] === expectedLines[line]) line++;
  console.log(`    first divergence at line ${line + 1}:`);
  console.log(`      on disk:  ${JSON.stringify(onDiskLines[line] ?? "<missing>")}`);
  console.log(`      expected: ${JSON.stringify(expectedLines[line] ?? "<missing>")}`);
  assert(
    false,
    "harness-capabilities.json is STALE — run `npm run generate:capabilities` and commit the result",
  );
}

// --- 2. Non-vacuity: the artifact carries the whole lineup ---------------------

const artifact = JSON.parse(onDisk) as HarnessCapabilitiesArtifact;

const registryNames = Object.keys(AGENT_REGISTRY).sort();
const artifactNames = Object.keys(artifact.harnesses).sort();
assert(
  JSON.stringify(artifactNames) === JSON.stringify(registryNames),
  `artifact names every registry harness (${artifactNames.join(", ")})`,
);
assert(
  artifact.reasoningEfforts.length >= 4,
  `artifact carries a graded effort vocabulary (${artifact.reasoningEfforts.length} values)`,
);

// --- 3. Internal invariants a consumer relies on -------------------------------

assert(
  artifact.binaryEffortValues.every((value) => artifact.reasoningEfforts.includes(value)),
  "binary effort values are a subset of the graded vocabulary",
);
assert(
  artifact.reasoningEfforts.includes(artifact.defaultReasoningEffort),
  `defaultReasoningEffort "${artifact.defaultReasoningEffort}" is in the vocabulary`,
);

for (const [name, harness] of Object.entries(artifact.harnesses)) {
  const registryEntry = AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY];
  assert(
    harness.defaultModel === registryEntry.defaultModel &&
      harness.models.some((model) => model.alias === harness.defaultModel),
    `${name}: defaultModel "${harness.defaultModel}" is the registry's and is in its own model list`,
  );
  assert(
    harness.efforts.every((value) => artifact.reasoningEfforts.includes(value)),
    `${name}: every advertised effort is in the graded vocabulary`,
  );
  const defaultEffortConsistent =
    harness.effortSupport === "none"
      ? harness.efforts.length === 0 && harness.defaultEffort === null
      : harness.defaultEffort !== null && harness.efforts.includes(harness.defaultEffort);
  assert(
    defaultEffortConsistent,
    `${name}: effortSupport "${harness.effortSupport}" agrees with efforts/defaultEffort`,
  );
}

// --- 4. The TS surface agrees with the artifact (same objects, not same source) -

const rebuilt = buildHarnessCapabilitiesArtifact();
assert(
  JSON.stringify(rebuilt.reasoningEfforts) === JSON.stringify([...REASONING_EFFORTS]),
  "exported REASONING_EFFORTS is the artifact's vocabulary",
);
for (const name of registryNames) {
  const entry = AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY];
  const models = artifact.harnesses[name].models;
  assert(
    models.length === entry.models.length &&
      models.every(
        (model, index) =>
          model.alias === entry.models[index].alias && model.modelId === entry.models[index].modelId,
      ),
    `${name}: artifact model list mirrors AGENT_REGISTRY (${models.length} models)`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
