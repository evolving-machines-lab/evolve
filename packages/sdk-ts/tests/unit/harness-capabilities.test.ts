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

// --- 5. DeepSeek V4.1 Flash: two routes, two route-visible names, one default --
// The model is on the claude, droid and opencode rosters under its OpenRouter
// id `openrouter/deepseek/deepseek-v4.1-flash` (owner 2026-09-10; the trace
// analyzer's and the check agent's default, swarm_dashboard
// lib/evaluations/analysis.ts DEFAULT_ANALYZE_MODEL) and, since 2026-09-11
// (owner: "a further option"), under `fireworks/deepseek-v4.1-flash` — the
// same model served from Fireworks through the gateway's exact entry for that
// name. Alias == wire id on both, the same spelling on all three rosters,
// neither a harness default; the retired Fireworks name `deepseek-flash` and
// the older `deepseek-v4-flash-vision` may not be advertised or sent (one
// name per route). Checked on both the registry and the artifact: the
// dashboard reads the artifact.

const OPENROUTER_DEEPSEEK_FLASH = "openrouter/deepseek/deepseek-v4.1-flash";
const FIREWORKS_DEEPSEEK_FLASH = "fireworks/deepseek-v4.1-flash";
const DEEPSEEK_FLASH_ROUTES = [OPENROUTER_DEEPSEEK_FLASH, FIREWORKS_DEEPSEEK_FLASH];
const RETIRED_DEEPSEEK_NAMES = ["deepseek-flash", "deepseek-v4-flash-vision"];
const carries = (models: readonly { alias: string; modelId: string }[], name: string) =>
  models.some((model) => model.alias === name && model.modelId === name);
const names = (models: readonly { alias: string; modelId: string }[], name: string) =>
  models.some((model) => model.alias === name || model.modelId === name);

for (const harness of ["claude", "droid", "opencode"] as const) {
  for (const route of DEEPSEEK_FLASH_ROUTES) {
    assert(
      carries(AGENT_REGISTRY[harness].models, route),
      `${harness} roster carries "${route}" with alias == wire id (the gateway's exact entry for it)`,
    );
    assert(
      carries(artifact.harnesses[harness].models, route),
      `artifact ${harness} roster advertises "${route}"`,
    );
  }
}
assert(
  registryNames.every(
    (name) =>
      AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY].defaultModel !== FIREWORKS_DEEPSEEK_FLASH &&
      artifact.harnesses[name].defaultModel !== FIREWORKS_DEEPSEEK_FLASH,
  ),
  `"${FIREWORKS_DEEPSEEK_FLASH}" is a further option, never a harness default (registry and artifact)`,
);
for (const retired of RETIRED_DEEPSEEK_NAMES) {
  assert(
    registryNames.every(
      (name) =>
        !names(AGENT_REGISTRY[name as keyof typeof AGENT_REGISTRY].models, retired) &&
        !names(artifact.harnesses[name].models, retired),
    ),
    `the retired "${retired}" is gone from every registry roster and the artifact (one name per route)`,
  );
}

// Both routes reach the gateway VERBATIM from the two harnesses that rewrite a
// model name on its way out: droid's gatewayModelAliases (applied by agent.ts
// resolveCommandModel before the Evolve-owned settings file is written) has
// no row for either, and opencode's command line prefixes `openrouter/` onto
// a BARE name only — a name that already carries its route rides as-is under
// the litellm provider, whose config keys the model by the same string.
for (const route of DEEPSEEK_FLASH_ROUTES) {
  assert(
    !(route in (AGENT_REGISTRY.droid.gatewayModelAliases ?? {})),
    `droid sends "${route}" verbatim (no gatewayModelAliases row rewrites it)`,
  );
  const command = AGENT_REGISTRY.opencode.buildCommand({ prompt: "p", model: route, isResume: false, isDirectMode: false });
  assert(
    command.includes(`--model litellm/${route} `),
    `opencode gateway command sends "${route}" verbatim under the litellm provider`,
  );
}
assert(
  AGENT_REGISTRY.opencode
    .buildCommand({ prompt: "p", model: "glm-5.3-flash", isResume: false, isDirectMode: false })
    .includes("--model litellm/openrouter/glm-5.3-flash "),
  "opencode still prefixes openrouter/ onto a bare name",
);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
