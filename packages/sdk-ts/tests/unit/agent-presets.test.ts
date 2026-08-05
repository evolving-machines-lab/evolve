#!/usr/bin/env tsx
/**
 * Unit Test: named agent-settings presets (no-internet / pinned-context)
 *
 * A preset is a platform-authored settings bundle delivered through the
 * native-config channel and stamped ON TOP of any user document — a
 * guarantee, not a default. What this pins down:
 *
 *   - the registry's delivery knowledge is exactly the ruled shape: claude
 *     stamps `permissions.deny` WebSearch/WebFetch (no-internet) and
 *     `autoCompactWindow` (pinned-context) into its settings document; codex
 *     rides `-c web_search=disabled` / `-c model_context_window` command
 *     flags (Harbor's exact web_search flag, codex.py:70-76);
 *   - stampNativeConfig merges a stamp on top of a user document: arrays
 *     union (the user's own deny list survives), scalars overwrite (a user
 *     autoCompactWindow cannot outvote the pin), untouched keys survive;
 *   - the door refuses what it cannot guarantee: an unknown preset name and
 *     a preset on a harness without delivery knowledge both raise
 *     EvolveConfigError naming the field, at .withAgent() — never a run
 *     silently missing its guarantee;
 *   - resolveAgentConfig carries the preset onto the resolved config, and
 *     codex's buildCommand splices presetFlags beside the effort flag where
 *     codex ranks them above config.toml.
 *
 * Usage:
 *   npm run test:unit:agent-presets
 *   npx tsx tests/unit/agent-presets.test.ts
 */

import { AGENT_REGISTRY, PINNED_CONTEXT_WINDOW_TOKENS } from "../../src/registry.js";
import { AGENT_PRESETS } from "../../src/types.js";
import type { AgentType } from "../../src/types.js";
import {
  EvolveConfigError,
  agentPresets,
  agentPresetTypes,
  resolveAgentConfig,
  stampNativeConfig,
  validateAgentConfig,
  validateAgentPreset,
} from "../../src/utils/config.js";

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${String(expected)}`);
    console.log(`      Actual:   ${String(actual)}`);
  }
}

/** Run `fn`, return what it threw (or undefined if it did not throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

// =============================================================================
// 1. Registry delivery knowledge is exactly the ruled shape
// =============================================================================
console.log("\n1. Registry delivery knowledge");

const claudePresets = AGENT_REGISTRY.claude.presets!;
const codexPresets = AGENT_REGISTRY.codex.presets!;

assertEqual(
  JSON.stringify(claudePresets["no-internet"]?.configStamp),
  JSON.stringify({ permissions: { deny: ["WebSearch", "WebFetch"] } }),
  "claude no-internet stamps permissions.deny WebSearch/WebFetch",
);
assertEqual(
  JSON.stringify(claudePresets["pinned-context"]?.configStamp),
  JSON.stringify({ autoCompactEnabled: true, autoCompactWindow: PINNED_CONTEXT_WINDOW_TOKENS }),
  "claude pinned-context stamps autoCompactEnabled + autoCompactWindow",
);
assertEqual(
  codexPresets["no-internet"]?.commandFlags,
  " -c web_search=disabled",
  "codex no-internet rides -c web_search=disabled (Harbor codex.py:70-76 enum)",
);
assertEqual(
  codexPresets["pinned-context"]?.commandFlags,
  ` -c model_context_window=${PINNED_CONTEXT_WINDOW_TOKENS}`,
  "codex pinned-context rides -c model_context_window",
);
assert(
  PINNED_CONTEXT_WINDOW_TOKENS >= 100000 && PINNED_CONTEXT_WINDOW_TOKENS <= 1000000,
  "pinned window sits inside Claude's documented autoCompactWindow range",
);
for (const preset of AGENT_PRESETS) {
  assertEqual(
    JSON.stringify(agentPresetTypes(preset)),
    JSON.stringify(["claude", "codex"]),
    `${preset} is guaranteed by exactly claude and codex`,
  );
}
for (const type of Object.keys(AGENT_REGISTRY) as AgentType[]) {
  if (type === "claude" || type === "codex") continue;
  assertEqual(agentPresets(type).length, 0, `${type} advertises no presets`);
}

// =============================================================================
// 2. stampNativeConfig: user base, preset on top
// =============================================================================
console.log("\n2. stampNativeConfig merge law");

const userDoc = {
  permissions: { deny: ["Bash(rm:*)"], allow: ["Read"] },
  autoCompactWindow: 900000,
  cleanupPeriodDays: 7,
};
const sealed = stampNativeConfig(userDoc, claudePresets["no-internet"]!.configStamp!);
assertEqual(
  JSON.stringify((sealed.permissions as { deny: string[] }).deny),
  JSON.stringify(["Bash(rm:*)", "WebSearch", "WebFetch"]),
  "deny arrays union: the user's own deny survives beside the preset's",
);
assertEqual(
  JSON.stringify((sealed.permissions as { allow: string[] }).allow),
  JSON.stringify(["Read"]),
  "sibling keys under a merged object survive",
);
assertEqual(sealed.cleanupPeriodDays, 7, "untouched top-level keys survive");

const pinned = stampNativeConfig(userDoc, claudePresets["pinned-context"]!.configStamp!);
assertEqual(
  pinned.autoCompactWindow,
  PINNED_CONTEXT_WINDOW_TOKENS,
  "scalar stamp overwrites: a user autoCompactWindow cannot outvote the pin",
);
assertEqual(pinned.autoCompactEnabled, true, "the pin also forces compaction on");

assertEqual(
  JSON.stringify(userDoc.permissions.deny),
  JSON.stringify(["Bash(rm:*)"]),
  "stampNativeConfig is pure: the input document is not mutated",
);

const dedup = stampNativeConfig(
  { permissions: { deny: ["WebSearch"] } },
  claudePresets["no-internet"]!.configStamp!,
);
assertEqual(
  JSON.stringify((dedup.permissions as { deny: string[] }).deny),
  JSON.stringify(["WebSearch", "WebFetch"]),
  "array union dedupes: a user's own WebSearch deny is not doubled",
);

// =============================================================================
// 3. The door refuses what it cannot guarantee
// =============================================================================
console.log("\n3. Typed refusals at the door");

const unknown = thrownBy(() => validateAgentPreset("claude", "offline"));
assert(unknown instanceof EvolveConfigError, "unknown preset name raises EvolveConfigError");
assertEqual((unknown as EvolveConfigError).field, "preset", "…naming the preset field");
assert(
  (unknown as Error).message.includes("no-internet") &&
    (unknown as Error).message.includes("pinned-context"),
  "…and listing the valid presets",
);

const unsupported = thrownBy(() => validateAgentPreset("gemini", "no-internet"));
assert(unsupported instanceof EvolveConfigError, "gemini + no-internet raises: gemini cannot guarantee it");
assert(
  (unsupported as Error).message.includes("claude") &&
    (unsupported as Error).message.includes("codex"),
  "…naming the agents that can",
);

assertEqual(
  thrownBy(() => validateAgentPreset("claude", "no-internet")),
  undefined,
  "claude + no-internet passes",
);
assertEqual(
  thrownBy(() => validateAgentConfig({ type: "codex", preset: "pinned-context" })),
  undefined,
  "validateAgentConfig accepts codex + pinned-context",
);
assert(
  thrownBy(() => validateAgentConfig({ type: "kimi", preset: "no-internet" } as never)) instanceof
    EvolveConfigError,
  "validateAgentConfig refuses kimi + no-internet (the .withAgent() door)",
);

// =============================================================================
// 4. Resolution carries the preset; codex splices the flags
// =============================================================================
console.log("\n4. Resolution and command splice");

const resolved = resolveAgentConfig({
  type: "codex",
  providerApiKey: "test-key",
  preset: "no-internet",
});
assertEqual(resolved.preset, "no-internet", "resolveAgentConfig carries the preset");

const resolvedNone = resolveAgentConfig({ type: "codex", providerApiKey: "test-key" });
assert(!("preset" in resolvedNone), "no preset declared = no preset key on the resolved config");

const command = AGENT_REGISTRY.codex.buildCommand({
  prompt: "hello",
  model: "gpt-5.6-sol",
  isResume: false,
  reasoningEffort: "high",
  presetFlags: codexPresets["no-internet"]!.commandFlags,
});
assert(
  command.includes(`-c model_reasoning_effort="high" -c web_search=disabled `),
  "codex command carries the preset -c beside the effort -c, before the positional flags",
);
const noPresetCommand = AGENT_REGISTRY.codex.buildCommand({
  prompt: "hello",
  model: "gpt-5.6-sol",
  isResume: false,
  reasoningEffort: "high",
});
assert(!noPresetCommand.includes("web_search"), "no preset = no web_search flag (codex's own default)");

// =============================================================================
// SUMMARY
// =============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
