#!/usr/bin/env tsx
/**
 * Unit Test: native agent config DELIVERY (the --ak channel's SDK half)
 *
 * The channel's whole point is a document landing INSIDE the sandbox as the
 * harness's own settings file. Every other test of the feature (validation,
 * TOML round-trip, CLI parsing, refusal lists) stayed green with the one
 * `writeNativeAgentConfig` call deleted — the file simply never appeared and
 * nothing noticed. This suite runs setupWorkspace against a recording mock
 * sandbox and pins the delivery itself:
 *
 *   - codex: the user document is written to the registry path
 *     (~/.codex/config.toml), chmod 600, BEFORE the platform's MCP and
 *     gateway-provider writers parse-and-rewrite the same file — so the final
 *     document carries the user's keys UNDER the platform's stamps
 *     (Harbor's merge order, codex.py:1022-1062, 1178-1181);
 *   - claude: the document is written to the dedicated per-run settings file
 *     (~/.claude/evolve-user-settings.json), chmod 600, and the platform's
 *     MCP writer never touches it — the file stays exactly the user document,
 *     and nativeConfigFlagPath() aims the --settings flag at that same path;
 *   - no config = no write: the settings path is never created and no chmod
 *     runs, so an agent without a document cannot grow a stray empty file;
 *   - presets ride the SAME delivery and are pinned here too, because every
 *     preset test elsewhere exercises pure helpers and stayed green with the
 *     delivery wiring reverted (effectiveNativeConfigDocument -> plain user
 *     config, presetFlags dropped from buildCommand): a claude preset ALONE
 *     writes the settings document carrying the deny/pin and --settings aims
 *     at it; a claude preset + user config lands as ONE merged document with
 *     the user's own deny surviving beside the platform's; a codex preset
 *     puts its -c flags on the actual built command line.
 *
 * Usage:
 *   npm run test:unit:native-config-delivery
 *   npx tsx tests/unit/native-config-delivery.test.ts
 */

import { parse as parseToml } from "smol-toml";
// Agent comes from dist (like config-validation.test.ts): importing
// src/agent.ts directly would drag the .md prompt assets through tsx, which
// only the build step knows how to inline.
import { Agent } from "../../dist/index.js";
import {
  AGENT_REGISTRY,
  expandPath,
  PINNED_CONTEXT_WINDOW_TOKENS,
} from "../../src/registry.ts";
import type {
  SandboxInstance,
  SandboxCommandHandle,
  SandboxCommandResult,
  ProcessInfo,
} from "../../src/types.ts";

// =============================================================================
// TEST HELPERS
// =============================================================================

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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${JSON.stringify(expected)}`);
    console.log(`      Actual:   ${JSON.stringify(actual)}`);
  }
}

// =============================================================================
// RECORDING MOCK SANDBOX
// =============================================================================

/** One box-touching step, in the order the SDK performed it. */
type SandboxEvent =
  | { kind: "write"; path: string; content: string }
  | { kind: "run"; cmd: string };

function createNoopHandle(): SandboxCommandHandle {
  return {
    processId: "p1",
    wait: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    kill: async (): Promise<boolean> => true,
  };
}

function createRecordingSandbox() {
  const files = new Map<string, string>();
  const events: SandboxEvent[] = [];

  const sandbox: SandboxInstance = {
    sandboxId: "sbx-native-config",
    commands: {
      run: async (cmd: string): Promise<SandboxCommandResult> => {
        events.push({ kind: "run", cmd });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: async (): Promise<SandboxCommandHandle> => createNoopHandle(),
      list: async (): Promise<ProcessInfo[]> => [],
      kill: async (): Promise<boolean> => true,
    },
    files: {
      read: async (path: string): Promise<string> => {
        if (!files.has(path)) throw new Error(`ENOENT: no such file: ${path}`);
        return files.get(path) as string;
      },
      write: async (
        path: string,
        content: string | Buffer | ArrayBuffer | Uint8Array,
      ): Promise<void> => {
        if (typeof content !== "string") {
          throw new Error("Recording sandbox only supports string writes in this test");
        }
        files.set(path, content);
        events.push({ kind: "write", path, content });
      },
      writeBatch: async (): Promise<void> => {},
      makeDir: async (): Promise<void> => {},
    },
    getHost: async (): Promise<string> => "http://localhost:3000",
    kill: async (): Promise<void> => {},
    pause: async (): Promise<void> => {},
  };

  return { sandbox, files, events };
}

/** Index of the first matching event, or -1. */
function firstIndex(events: SandboxEvent[], match: (e: SandboxEvent) => boolean): number {
  return events.findIndex(match);
}

function writesTo(events: SandboxEvent[], path: string): Array<{ index: number; content: string }> {
  return events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.kind === "write" && e.path === path)
    .map(({ e, index }) => ({ index, content: (e as { content: string }).content }));
}

// =============================================================================
// FIXTURES
// =============================================================================

const CODEX_USER_DOC = {
  approval_policy: "never",
  sandbox_mode: "workspace-write",
  tui: { theme: "dark" },
};

const CLAUDE_USER_DOC = {
  includeCoAuthoredBy: false,
  permissions: { deny: ["Bash(rm -rf *)"] },
};

const MCP_SERVERS = {
  context7: { url: "https://mcp.example.test/mcp", type: "http" as const },
};

const CODEX_CONFIG_PATH = expandPath(AGENT_REGISTRY.codex.nativeConfig!.path);
const CLAUDE_SETTINGS_PATH = expandPath(AGENT_REGISTRY.claude.nativeConfig!.path);

async function runSetupWorkspace(
  type: "codex" | "claude",
  config: Record<string, unknown> | undefined,
  preset?: "no-internet" | "pinned-context",
): Promise<ReturnType<typeof createRecordingSandbox>> {
  const recording = createRecordingSandbox();
  const agent = new Agent(
    { type, apiKey: "sk-evolve-test", isDirectMode: false, config, preset },
    { mcpServers: MCP_SERVERS },
  );
  // The private setup path every fresh sandbox goes through before the
  // harness runs — the exact call whose deletion this suite exists to catch.
  await (agent as unknown as {
    setupWorkspace(sandbox: SandboxInstance): Promise<void>;
  }).setupWorkspace(recording.sandbox);
  return recording;
}

// =============================================================================
// TESTS
// =============================================================================

/** Codex: the document IS the base config.toml, written before the stamps. */
async function testCodexDelivery(): Promise<void> {
  console.log("\n[1] codex: user document written at the registry path, as the BASE");

  assertEqual(
    CODEX_CONFIG_PATH,
    "/home/user/.codex/config.toml",
    "the registry path is codex's real config location",
  );

  const { events, files } = await runSetupWorkspace("codex", CODEX_USER_DOC);
  const configWrites = writesTo(events, CODEX_CONFIG_PATH);

  assert(configWrites.length >= 1, "the config.toml was written at all (the delivery exists)");

  // The FIRST write of the file is exactly the user document — nothing else
  // has touched it yet, which is what makes it the BASE layer.
  const firstWrite = configWrites[0];
  let firstDoc: unknown;
  try {
    firstDoc = firstWrite ? parseToml(firstWrite.content) : undefined;
  } catch {
    firstDoc = undefined;
  }
  assertDeepEqual(
    firstDoc,
    CODEX_USER_DOC,
    "the FIRST config.toml write is the user document verbatim (the base, no stamps yet)",
  );

  // mkdir -p of the parent directory precedes the write.
  const mkdirIndex = firstIndex(
    events,
    (e) => e.kind === "run" && e.cmd.includes("mkdir -p") && e.cmd.includes("/.codex"),
  );
  assert(
    mkdirIndex !== -1 && firstWrite !== undefined && mkdirIndex < firstWrite.index,
    "the parent directory is created before the document is written",
  );

  // chmod 600, after the write — a settings file can carry private values.
  const chmodIndex = firstIndex(
    events,
    (e) => e.kind === "run" && e.cmd === `chmod 600 ${CODEX_CONFIG_PATH}`,
  );
  assert(
    chmodIndex !== -1 && firstWrite !== undefined && chmodIndex > firstWrite.index,
    "the document is chmod 600 right after it is written",
  );

  // MERGE-ORDER LAW (Harbor codex.py:1022-1062): the platform's writers
  // parse-and-rewrite the SAME file AFTER the base — so the final document
  // carries the user's keys UNDER the platform's mcp + gateway stamps. Had
  // the base been written last, it would have clobbered the stamps (an
  // unmetered run); had it never been written, the user keys would be gone.
  assert(
    configWrites.length >= 3,
    "the platform's MCP and gateway-provider writers rewrote the file after the base",
  );
  const finalDoc = parseToml(files.get(CODEX_CONFIG_PATH) ?? "") as Record<string, unknown>;
  assertEqual(
    finalDoc.approval_policy as string,
    "never",
    "the user's scalar key survives under the stamps",
  );
  assertDeepEqual(
    finalDoc.tui,
    { theme: "dark" },
    "the user's nested table survives under the stamps",
  );
  assert(
    typeof (finalDoc.mcp_servers as Record<string, unknown>)?.context7 === "object",
    "the platform's MCP stamp landed ON TOP of the user base",
  );
  assertEqual(
    finalDoc.model_provider as string,
    "evolve-gateway",
    "the platform's gateway routing stamp landed ON TOP — the meter cannot be undone by the user document",
  );
}

/** Claude: a dedicated per-run file the platform writers never touch. */
async function testClaudeDelivery(): Promise<void> {
  console.log("\n[2] claude: dedicated settings file, untouched by the platform writers");

  assertEqual(
    CLAUDE_SETTINGS_PATH,
    "/home/user/.claude/evolve-user-settings.json",
    "the registry path is the dedicated per-run settings file, never settings.json",
  );

  const { events, files } = await runSetupWorkspace("claude", CLAUDE_USER_DOC);
  const settingsWrites = writesTo(events, CLAUDE_SETTINGS_PATH);

  assertEqual(
    settingsWrites.length,
    1,
    "the settings document is written exactly once — no platform writer rewrites it",
  );
  assertDeepEqual(
    settingsWrites[0] ? JSON.parse(settingsWrites[0].content) : undefined,
    CLAUDE_USER_DOC,
    "the written document is the user document verbatim",
  );

  const chmodIndex = firstIndex(
    events,
    (e) => e.kind === "run" && e.cmd === `chmod 600 ${CLAUDE_SETTINGS_PATH}`,
  );
  assert(
    chmodIndex !== -1 && settingsWrites[0] !== undefined && chmodIndex > settingsWrites[0].index,
    "the document is chmod 600 right after it is written",
  );

  // The platform's MCP writer worked beside it — on ITS files, not this one.
  assert(
    files.has("/home/user/.claude/settings.json"),
    "the platform MCP writer used ~/.claude/settings.json (its own file)",
  );
  assertDeepEqual(
    JSON.parse(files.get(CLAUDE_SETTINGS_PATH) ?? "null"),
    CLAUDE_USER_DOC,
    "after ALL setup, the dedicated file still holds exactly the user document",
  );

  // …and the --settings flag will aim at the same path the write landed on.
  const agent = new Agent(
    { type: "claude", apiKey: "sk-evolve-test", isDirectMode: false, config: CLAUDE_USER_DOC },
    {},
  );
  const flagPath = (agent as unknown as {
    nativeConfigFlagPath(): string | undefined;
  }).nativeConfigFlagPath();
  assertEqual(
    flagPath,
    CLAUDE_SETTINGS_PATH,
    "nativeConfigFlagPath() aims --settings at the exact path the delivery wrote",
  );
}

/** No config = no write: absence never creates a stray settings file. */
async function testNoConfigNoWrite(): Promise<void> {
  console.log("\n[3] no config: the settings path is never written, no chmod runs");

  for (const [type, path] of [
    ["codex", CODEX_CONFIG_PATH],
    ["claude", CLAUDE_SETTINGS_PATH],
  ] as const) {
    const { events } = await runSetupWorkspace(type, undefined);
    const baseWrites = writesTo(events, path).filter(({ index }) => {
      // codex's platform writers legitimately create config.toml even without
      // a user document — only a write of the USER BASE (before any platform
      // section exists in it) would betray a phantom delivery. The user base
      // write is the one NOT containing platform sections.
      const content = events[index] as { kind: "write"; content: string };
      return (
        !content.content.includes("mcp_servers") &&
        !content.content.includes("model_provider") &&
        !content.content.includes("enableAllProjectMcpServers")
      );
    });
    assertEqual(
      baseWrites.length,
      0,
      `${type}: no user-base document is written when the agent has no config`,
    );
    const chmod = firstIndex(events, (e) => e.kind === "run" && e.cmd === `chmod 600 ${path}`);
    assertEqual(chmod, -1, `${type}: no chmod runs when nothing was delivered`);
  }
}

/**
 * Claude preset ALONE: the preset IS a settings document. The guarantee
 * cannot depend on the user also bringing a config — so with no user config
 * at all, the stamped document must still land in the sandbox and the
 * --settings flag must still aim at it. This is exactly what a reverted
 * effectiveNativeConfigDocument (plain `this.agentConfig.config`) silently
 * drops: the preset gets accepted, stored, echoed — and never delivered.
 */
async function testClaudePresetAloneDelivery(): Promise<void> {
  console.log("\n[4] claude preset alone: the stamp IS the delivered settings document");

  // no-internet: the deny lands in the box.
  {
    const { events, files } = await runSetupWorkspace("claude", undefined, "no-internet");
    const settingsWrites = writesTo(events, CLAUDE_SETTINGS_PATH);
    assertEqual(
      settingsWrites.length,
      1,
      "no-internet with no user config still writes the settings document exactly once",
    );
    const doc = JSON.parse(files.get(CLAUDE_SETTINGS_PATH) ?? "null") as {
      permissions?: { deny?: string[] };
    } | null;
    const deny = doc?.permissions?.deny ?? [];
    assert(
      deny.includes("WebSearch") && deny.includes("WebFetch"),
      "the delivered document denies WebSearch and WebFetch (the no-internet guarantee)",
    );
    const chmodIndex = firstIndex(
      events,
      (e) => e.kind === "run" && e.cmd === `chmod 600 ${CLAUDE_SETTINGS_PATH}`,
    );
    assert(
      chmodIndex !== -1 && settingsWrites[0] !== undefined && chmodIndex > settingsWrites[0].index,
      "the preset document is chmod 600 right after it is written",
    );
  }

  // pinned-context: the window pin lands in the box.
  {
    const { files } = await runSetupWorkspace("claude", undefined, "pinned-context");
    const doc = JSON.parse(files.get(CLAUDE_SETTINGS_PATH) ?? "null") as Record<
      string,
      unknown
    > | null;
    assertEqual(
      doc?.autoCompactWindow as number,
      PINNED_CONTEXT_WINDOW_TOKENS,
      "the delivered document pins autoCompactWindow to the platform number",
    );
    assertEqual(
      doc?.autoCompactEnabled as boolean,
      true,
      "the delivered document forces autoCompactEnabled on, so a default cannot disable the pin",
    );
  }

  // …and --settings aims at the document a preset-only agent wrote.
  const agent = new Agent(
    { type: "claude", apiKey: "sk-evolve-test", isDirectMode: false, preset: "no-internet" },
    {},
  );
  const flagPath = (agent as unknown as {
    nativeConfigFlagPath(): string | undefined;
  }).nativeConfigFlagPath();
  assertEqual(
    flagPath,
    CLAUDE_SETTINGS_PATH,
    "nativeConfigFlagPath() aims --settings at the preset document even with no user config",
  );
}

/**
 * Claude preset + user config: ONE merged document, user base under the
 * platform stamp, arrays unioned — the user's own deny survives BESIDE the
 * platform's, never replaced by it.
 */
async function testClaudePresetMergedWithUserConfig(): Promise<void> {
  console.log("\n[5] claude preset + user config: one merged document, user deny surviving");

  const { events, files } = await runSetupWorkspace("claude", CLAUDE_USER_DOC, "no-internet");
  const settingsWrites = writesTo(events, CLAUDE_SETTINGS_PATH);
  assertEqual(
    settingsWrites.length,
    1,
    "preset + user config is still exactly one settings write (one merged document)",
  );
  const doc = JSON.parse(files.get(CLAUDE_SETTINGS_PATH) ?? "null") as {
    includeCoAuthoredBy?: boolean;
    permissions?: { deny?: string[] };
  } | null;
  const deny = doc?.permissions?.deny ?? [];
  assert(
    deny.includes("Bash(rm -rf *)"),
    "the user's own deny entry survives the platform stamp (arrays union, not overwrite)",
  );
  assert(
    deny.includes("WebSearch") && deny.includes("WebFetch"),
    "the platform's WebSearch/WebFetch deny landed beside the user's entry",
  );
  assertEqual(
    doc?.includeCoAuthoredBy,
    false,
    "the user's unrelated settings key survives in the merged document",
  );
}

/**
 * Codex presets ride the ACTUAL built command line — the -c flags codex
 * ranks above config.toml. Dropping `presetFlags` from the buildCommand
 * options is exactly the revert that left every helper test green while the
 * real command ran unsealed.
 */
async function testCodexPresetOnBuiltCommand(): Promise<void> {
  console.log("\n[6] codex preset: the -c flags are on the actual built command");

  const buildFor = (preset: "no-internet" | "pinned-context", config?: Record<string, unknown>): string => {
    const agent = new Agent(
      { type: "codex", apiKey: "sk-evolve-test", isDirectMode: false, config, preset },
      {},
    );
    return (agent as unknown as { buildCommand(prompt: string): string }).buildCommand("hello");
  };

  const sealed = buildFor("no-internet");
  assert(
    sealed.includes(" -c web_search=disabled"),
    "no-internet puts -c web_search=disabled on the command (harbor's exact flag and enum)",
  );

  const pinned = buildFor("pinned-context");
  assert(
    pinned.includes(` -c model_context_window=${PINNED_CONTEXT_WINDOW_TOKENS}`),
    "pinned-context puts -c model_context_window on the command with the platform number",
  );

  // The flag survives a user config too: the command line is what codex
  // ranks above the config.toml that document becomes.
  const sealedWithConfig = buildFor("no-internet", CODEX_USER_DOC);
  assert(
    sealedWithConfig.includes(" -c web_search=disabled"),
    "the seal stays on the command line even when the user brought a config.toml document",
  );

  // And a preset-less command carries no preset flags — the seal is opt-in.
  const openAgent = new Agent(
    { type: "codex", apiKey: "sk-evolve-test", isDirectMode: false },
    {},
  );
  const open = (openAgent as unknown as { buildCommand(prompt: string): string }).buildCommand(
    "hello",
  );
  assert(
    !open.includes("web_search") && !open.includes("model_context_window"),
    "no preset = no preset flags on the command",
  );
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Native Agent Config Delivery Unit Tests");
  console.log("=".repeat(60));

  await testCodexDelivery();
  await testClaudeDelivery();
  await testNoConfigNoWrite();
  await testClaudePresetAloneDelivery();
  await testClaudePresetMergedWithUserConfig();
  await testCodexPresetOnBuiltCommand();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test run crashed:", error);
  process.exit(1);
});
