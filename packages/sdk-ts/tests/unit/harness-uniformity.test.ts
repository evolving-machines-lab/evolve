#!/usr/bin/env tsx
/**
 * Every AGENT_REGISTRY entry carries the same wiring, checked not assumed (owner
 * requirement 2026-09-25; shared by every harness lane, so no harness is named).
 * The switch tables are read from source: a `default:` arm cannot pass here.
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
  harnesses: Record<string, { defaultModel: string; models: Array<{ alias: string }>; efforts: string[] }>;
};

const HARNESSES = Object.keys(AGENT_REGISTRY) as AgentType[];

/**
 * Home-relative spelling shared by the three tables: the registry writes `~/x`
 * (checkpointDirs, mcpConfig) or bare `x` (checkpointExcludes, resolved under
 * the home by storage/index.ts), hosted/trial-tree.ts writes `/root/x`.
 */
const rel = (path: string): string => path.replace(/^(~|\/root)\//, "");
const under = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

console.log("\n=== Harness uniformity (every AGENT_REGISTRY entry, the same invariants) ===\n");

assert(HARNESSES.length > 0, `the registry names ${HARNESSES.length} harnesses`);
assert(
  JSON.stringify([...HARNESSES].sort()) === JSON.stringify(Object.keys(ARTIFACT.harnesses).sort()),
  "harness-capabilities.json names exactly the registry's harnesses",
);
assert(
  JSON.stringify([...HARNESSES].sort()) === JSON.stringify(Object.keys(HARNESS_TRIAL_LAYOUTS).sort()),
  "hosted/trial-tree.ts lays out exactly the registry's harnesses",
);

for (const name of HARNESSES) {
  const entry = AGENT_REGISTRY[name];
  console.log(`\n[${name}]`);

  assert(typeof entry.systemPromptFile === "string" && entry.systemPromptFile.length > 0, `${name}: instructions file set (${entry.systemPromptFile})`);

  const mcp = entry.mcpConfig;
  assert(
    typeof mcp?.settingsDir === "string" && mcp.settingsDir.length > 0 && typeof mcp.filename === "string" && mcp.filename.length > 0,
    `${name}: MCP config path set (${mcp?.settingsDir}/${mcp?.filename})`,
  );
  assert(typeof mcp?.format === "string" && mcp.format.length > 0, `${name}: MCP config format declared (${mcp?.format})`);

  assert(typeof entry.skillsConfig?.targetDir === "string" && entry.skillsConfig.targetDir.length > 0, `${name}: skills dir set (${entry.skillsConfig?.targetDir})`);

  // The checkpoint home: storage/index.ts buildTarCommand reads checkpointDirs, else the MCP settings dir.
  const homeDirs = entry.checkpointDirs?.length ? entry.checkpointDirs : [mcp.settingsDir];
  const homeRoots = homeDirs.map(rel);
  assert(homeDirs.length > 0 && homeDirs.every((dir) => dir.startsWith("~/")), `${name}: checkpoint home root(s) under the home (${homeDirs.join(", ")})`);
  const skips = entry.checkpointExcludes ?? [];
  assert(Array.isArray(skips), `${name}: checkpoint skip list declared (${skips.length} entries)`);
  assert(skips.every((skip) => under(rel(skip), homeRoots)), `${name}: every skip sits under a checkpoint root`);

  assert(typeof entry.apiKeyEnv === "string" && /^[A-Z][A-Z0-9_]*$/.test(entry.apiKeyEnv), `${name}: apiKeyEnv is an env NAME (${entry.apiKeyEnv})`);
  assert(typeof entry.image === "string" && entry.image.length > 0, `${name}: sandbox image set (${entry.image})`);
  assert(typeof entry.effortSupport === "string" && entry.effortSupport.length > 0, `${name}: effortSupport declared (${entry.effortSupport})`);

  const roster = entry.models.map((m) => m.alias);
  assert(roster.length > 0 && roster.includes(entry.defaultModel), `${name}: default model is on its own roster (${entry.defaultModel})`);
  assert(new Set(roster).size === roster.length, `${name}: roster aliases are unique`);
  assert(typeof entry.buildCommand === "function", `${name}: buildCommand is a function`);

  const layout = HARNESS_TRIAL_LAYOUTS[name];
  assert(layout !== undefined, `${name}: hosted trial layout row present`);
  // A plain file name with an extension; the extension is the harness's (Harbor names some tees .jsonl).
  assert(/^[a-z0-9-]+\.[a-z0-9]+$/.test(layout?.stdoutFile ?? ""), `${name}: tee file named (${layout?.stdoutFile})`);
  assert(Array.isArray(layout?.harborCopies), `${name}: Harbor copy list declared (${layout?.harborCopies.length ?? "?"} roots)`);
  assert(
    (layout?.harborCopies ?? []).every((copy) => under(rel(copy.sandboxRoot), homeRoots)),
    `${name}: every Harbor copy root sits inside the checkpoint home`,
  );

  assert(PARSERS_INDEX.includes(`case "${name}":`), `${name}: createAgentParser has its own branch`);
  assert(typeof createAgentParser(name) === "function", `${name}: createAgentParser returns a parser`);
  assert(MCP_INDEX.includes(`case "${name}":`), `${name}: writeMcpConfig has its own branch`);
  assert(AGENT.includes(`case "${name}":`), `${name}: providerRuntimeProviderForAgent names it`);

  const artifact = ARTIFACT.harnesses[name];
  assert(
    artifact !== undefined && artifact.defaultModel === entry.defaultModel && artifact.models.some((m) => m.alias === entry.defaultModel),
    `${name}: harness-capabilities.json carries it, same default, default on its roster`,
  );
  assert(
    artifact !== undefined && (entry.efforts === undefined || JSON.stringify(artifact.efforts) === JSON.stringify(entry.efforts)),
    `${name}: the artifact advertises the registry's effort roster`,
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
