/**
 * Uniformity across harnesses (owner requirement 2026-09-25): a new harness
 * lands exactly like the existing ones, and the sameness is checked over EVERY
 * registry entry, not assumed. This file covers what the SDK owns — the
 * instructions file, the MCP config path and format, the skills directory, the
 * home root and its skip list, the trial layout row. The hosted half (Harbor
 * name, tee file, transcript glob, door row) is checked in the platform repo.
 */

import { AGENT_REGISTRY } from "../../src/registry.ts";
import { AGENT_TYPES } from "../../src/types.ts";
import { DEFAULT_HARNESS_TRIAL_LAYOUT, HARNESS_TRIAL_LAYOUTS, harnessTrialLayout } from "../../src/hosted/trial-tree.ts";

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

const harnesses = Object.keys(AGENT_REGISTRY) as (keyof typeof AGENT_REGISTRY)[];

console.log("\n[1] the roster: one registry entry per AgentType, one trial layout per entry");
assert(
  [...Object.values(AGENT_TYPES)].sort().join(",") === [...harnesses].sort().join(","),
  "AGENT_TYPES and AGENT_REGISTRY name the same harnesses",
);
for (const harness of harnesses) {
  assert(harness in HARNESS_TRIAL_LAYOUTS, `${harness}: has its own trial layout row (never the bring-your-own default)`);
  assert(harnessTrialLayout(harness) !== DEFAULT_HARNESS_TRIAL_LAYOUT, `${harness}: the row is resolved by the harness id`);
}

for (const harness of harnesses) {
  const entry = AGENT_REGISTRY[harness];
  console.log(`\n[${harness}] the same invariants as every other harness`);

  assert(/^[A-Z]+\.md$/.test(entry.systemPromptFile), `instructions file set (${entry.systemPromptFile})`);

  const { settingsDir, filename, format } = entry.mcpConfig;
  assert(settingsDir.length > 0 && filename.length > 0, `MCP config path set (${settingsDir}/${filename})`);
  assert((format === "json" || format === "toml") && filename.endsWith(`.${format}`), `MCP config format set and matches the file name (${format})`);

  assert(entry.skillsConfig.targetDir.startsWith("~/"), `skills directory set under the home (${entry.skillsConfig.targetDir})`);

  // The checkpoint's home roots: the declared list, else the MCP settings dir (storage/index.ts buildTarCommand).
  const roots = entry.checkpointDirs?.length ? entry.checkpointDirs : [settingsDir];
  assert(roots.every((root) => root.startsWith("~/")), `home root declared under ~ (${roots.join(", ")})`);
  const skips = entry.checkpointExcludes ?? [];
  assert(
    skips.every((skip) => roots.some((root) => skip.startsWith(root.slice(2) + "/") || skip.startsWith(root.slice(2)))),
    `home skip list (${skips.length}) lies under a declared root`,
  );

  const layout = HARNESS_TRIAL_LAYOUTS[harness];
  assert(/^[a-z-]+\.(txt|jsonl)$/.test(layout.stdoutFile), `stdout tee name is Harbor-shaped (${layout.stdoutFile})`);
  assert(Array.isArray(layout.harborCopies), "Harbor copy slots declared (possibly none)");

  assert(entry.models.some((m) => m.alias === entry.defaultModel), `default model (${entry.defaultModel}) is on its own roster`);
  assert(entry.apiKeyEnv.length > 0, `API key env name set (${entry.apiKeyEnv})`);
}

console.log("\n" + "=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
if (failed > 0) process.exit(1);
