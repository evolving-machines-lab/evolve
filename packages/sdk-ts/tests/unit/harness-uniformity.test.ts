#!/usr/bin/env tsx
/**
 * Unit Test: every harness in AGENT_REGISTRY carries the same wiring, checked
 * not assumed (owner requirement 2026-09-25, added to every harness lane).
 *
 * One table, one loop: for every registry entry the same invariants hold —
 * an instructions file, an MCP config path and format, a skills directory, a
 * default model that is on its own roster, a per-harness parser, an MCP
 * writer branch, a provider-runtime branch, a hosted trial layout with a tee
 * file, and a capability-artifact entry. A harness that satisfies only some
 * of them is a harness the rest of the platform will treat differently.
 *
 * The switch-based tables (parsers/index.ts, mcp/index.ts, agent.ts) are read
 * from SOURCE: a `default:` arm that swallows a new name is exactly the drift
 * this file exists to catch, and no runtime probe can tell a real branch from
 * the fallback.
 *
 * Usage:
 *   npm run test:unit:uniformity
 *   npx tsx tests/unit/harness-uniformity.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_REGISTRY } from "../../src/registry";
import { HARNESS_TRIAL_LAYOUTS } from "../../src/hosted/trial-tree";
import { createAgentParser } from "../../src/parsers";
import type { AgentType } from "../../src/types";

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

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf8");

const PARSERS_INDEX = read("parsers/index.ts");
const MCP_INDEX = read("mcp/index.ts");
const AGENT = read("agent.ts");
const ARTIFACT = JSON.parse(readFileSync(join(SRC, "..", "harness-capabilities.json"), "utf8")) as {
  harnesses: Record<string, { defaultModel: string; models: Array<{ alias: string }> }>;
};

const MCP_FORMATS = new Set(["json", "toml", "yaml"]);
const HARNESSES = Object.keys(AGENT_REGISTRY) as AgentType[];

console.log("\n=== Harness uniformity (every AGENT_REGISTRY entry, the same invariants) ===\n");

assert(HARNESSES.length >= 8, `the registry names ${HARNESSES.length} harnesses (the seven plus dsh at least)`);

for (const name of HARNESSES) {
  const entry = AGENT_REGISTRY[name];
  console.log(`\n[${name}]`);

  assert(typeof entry.systemPromptFile === "string" && entry.systemPromptFile.length > 0, `${name}: instructions file set (${entry.systemPromptFile})`);

  const mcp = entry.mcpConfig;
  assert(
    typeof mcp?.settingsDir === "string" && mcp.settingsDir.length > 0 && typeof mcp.filename === "string" && mcp.filename.length > 0,
    `${name}: MCP config path set (${mcp?.settingsDir}/${mcp?.filename})`,
  );
  assert(MCP_FORMATS.has(mcp?.format ?? ""), `${name}: MCP config format is one of json/toml/yaml (${mcp?.format})`);

  assert(typeof entry.skillsConfig?.targetDir === "string" && entry.skillsConfig.targetDir.length > 0, `${name}: skills dir set (${entry.skillsConfig?.targetDir})`);

  assert(typeof entry.apiKeyEnv === "string" && /^[A-Z][A-Z0-9_]*$/.test(entry.apiKeyEnv), `${name}: apiKeyEnv is an env NAME (${entry.apiKeyEnv})`);
  assert(typeof entry.image === "string" && entry.image.length > 0, `${name}: sandbox image set (${entry.image})`);
  assert(["level", "binary", "none"].includes(entry.effortSupport), `${name}: effortSupport declared (${entry.effortSupport})`);

  const roster = entry.models.map((m) => m.alias);
  assert(roster.length > 0 && roster.includes(entry.defaultModel), `${name}: default model is on its own roster (${entry.defaultModel})`);
  assert(new Set(roster).size === roster.length, `${name}: roster aliases are unique`);
  assert(typeof entry.buildCommand === "function", `${name}: buildCommand is a function`);

  const layout = HARNESS_TRIAL_LAYOUTS[name];
  assert(layout !== undefined, `${name}: hosted trial layout row present`);
  assert(/^[a-z0-9-]+\.(txt|log)$/.test(layout?.stdoutFile ?? ""), `${name}: tee file named (${layout?.stdoutFile})`);
  assert(Array.isArray(layout?.harborCopies), `${name}: Harbor copy list declared (${layout?.harborCopies.length ?? "?"} roots)`);

  assert(PARSERS_INDEX.includes(`case "${name}":`), `${name}: createAgentParser has its own branch`);
  assert(typeof createAgentParser(name) === "function", `${name}: createAgentParser returns a parser`);
  assert(MCP_INDEX.includes(`case "${name}":`), `${name}: writeMcpConfig has its own branch`);
  assert(AGENT.includes(`case "${name}":`), `${name}: providerRuntimeProviderForAgent names it`);

  const artifact = ARTIFACT.harnesses[name];
  assert(
    artifact !== undefined && artifact.defaultModel === entry.defaultModel && artifact.models.some((m) => m.alias === entry.defaultModel),
    `${name}: harness-capabilities.json carries it, same default, default on its roster`,
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
