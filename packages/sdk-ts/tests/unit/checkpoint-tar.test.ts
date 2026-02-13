#!/usr/bin/env tsx
/**
 * Unit Test: Checkpoint Tar Command & Path Normalization
 *
 * Tests buildTarCommand() for all agent types, plus normalizeAgentDir()
 * and normalizeWorkspaceDir() path helpers.
 *
 * Usage:
 *   npm run test:unit:checkpoint-tar
 *   npx tsx tests/unit/checkpoint-tar.test.ts
 */

import {
  buildTarCommand,
  normalizeAgentDir,
  normalizeWorkspaceDir,
} from "../../src/storage/index.ts";

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const match = actual === expected;
  if (match) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

async function assertThrows(fn: () => unknown, substring: string, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  \u2717 ${message} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) {
      passed++;
      console.log(`  \u2713 ${message}`);
    } else {
      failed++;
      console.log(`  \u2717 ${message} (threw "${msg}", expected to contain "${substring}")`);
    }
  }
}

// =============================================================================
// TESTS: normalizeAgentDir
// =============================================================================

async function testNormalizeAgentDir(): Promise<void> {
  console.log("\n[1] normalizeAgentDir()");

  assertEqual(normalizeAgentDir("~/.claude"), ".claude", "~/.claude -> .claude");
  assertEqual(normalizeAgentDir("~/.codex"), ".codex", "~/.codex -> .codex");
  assertEqual(normalizeAgentDir("~/.gemini"), ".gemini", "~/.gemini -> .gemini");
  assertEqual(normalizeAgentDir("~/.qwen"), ".qwen", "~/.qwen -> .qwen");

  // /home/user/ prefix
  assertEqual(normalizeAgentDir("/home/user/.claude"), ".claude", "/home/user/.claude -> .claude");

  // Already relative
  assertEqual(normalizeAgentDir(".myagent"), ".myagent", "Already relative dot-prefixed");

  // Unexpected path
  await assertThrows(
    () => normalizeAgentDir("unexpected/path"),
    "Unexpected settingsDir",
    "Unexpected path throws"
  );

  // Path traversal rejected
  await assertThrows(
    () => normalizeAgentDir("../../etc"),
    "must not contain '..'",
    "Path traversal in settingsDir throws"
  );
}

// =============================================================================
// TESTS: normalizeWorkspaceDir
// =============================================================================

async function testNormalizeWorkspaceDir(): Promise<void> {
  console.log("\n[2] normalizeWorkspaceDir()");

  assertEqual(
    normalizeWorkspaceDir("/home/user/workspace"),
    "workspace",
    "/home/user/workspace -> workspace"
  );

  assertEqual(
    normalizeWorkspaceDir("/home/user/myproject"),
    "myproject",
    "/home/user/myproject -> myproject"
  );

  assertEqual(
    normalizeWorkspaceDir("/home/user/deep/nested/dir"),
    "deep/nested/dir",
    "Nested paths preserved"
  );

  // Invalid prefix
  await assertThrows(
    () => normalizeWorkspaceDir("/other/path"),
    "Must start with /home/user/",
    "Non /home/user/ path throws"
  );

  // Path traversal rejected
  await assertThrows(
    () => normalizeWorkspaceDir("/home/user/../../etc"),
    "must not contain '..'",
    "Path traversal in workingDir throws"
  );

  // Double-slash bypass rejected
  await assertThrows(
    () => normalizeWorkspaceDir("/home/user//etc"),
    "resolves to invalid path",
    "Double-slash bypass throws"
  );

  // Empty after slice rejected
  await assertThrows(
    () => normalizeWorkspaceDir("/home/user/"),
    "resolves to invalid path",
    "Bare /home/user/ (empty after slice) throws"
  );

  // Trailing slash stripped
  assertEqual(
    normalizeWorkspaceDir("/home/user/workspace/"),
    "workspace",
    "Trailing slash stripped: /home/user/workspace/ -> workspace"
  );
}

// =============================================================================
// TESTS: buildTarCommand per agent type
// =============================================================================

async function testBuildTarCommandClaude(): Promise<void> {
  console.log("\n[3] buildTarCommand() - claude");

  const cmd = buildTarCommand("claude", "/home/user/workspace");

  // Must include workspace/ and .claude/
  assert(cmd.includes("workspace/"), "Includes workspace/ directory");
  assert(cmd.includes(".claude/"), "Includes .claude/ settings directory");

  // Must be a tar -czf command
  assert(cmd.startsWith("tar -czf /tmp/evolve-ckpt.tar.gz"), "Starts with tar -czf");

  // Must include sha256sum
  assert(cmd.includes("sha256sum /tmp/evolve-ckpt.tar.gz"), "Includes sha256sum");

  // Must archive from /home/user
  assert(cmd.includes("-C /home/user"), "Archives from /home/user");
}

async function testBuildTarCommandCodex(): Promise<void> {
  console.log("\n[4] buildTarCommand() - codex");

  const cmd = buildTarCommand("codex", "/home/user/workspace");

  assert(cmd.includes("workspace/"), "Includes workspace/ directory");
  assert(cmd.includes(".codex/"), "Includes .codex/ settings directory");
}

async function testBuildTarCommandGemini(): Promise<void> {
  console.log("\n[5] buildTarCommand() - gemini");

  const cmd = buildTarCommand("gemini", "/home/user/workspace");

  assert(cmd.includes("workspace/"), "Includes workspace/ directory");
  assert(cmd.includes(".gemini/"), "Includes .gemini/ settings directory");
}

async function testBuildTarCommandQwen(): Promise<void> {
  console.log("\n[6] buildTarCommand() - qwen");

  const cmd = buildTarCommand("qwen", "/home/user/workspace");

  assert(cmd.includes("workspace/"), "Includes workspace/ directory");
  assert(cmd.includes(".qwen/"), "Includes .qwen/ settings directory");
}

async function testBuildTarCommandKimi(): Promise<void> {
  console.log("\n[6b] buildTarCommand() - kimi");

  const cmd = buildTarCommand("kimi", "/home/user/workspace");

  assert(cmd.includes("workspace/"), "Includes workspace/ directory");
  assert(cmd.includes(".kimi/"), "Includes .kimi/ settings directory");
}

async function testBuildTarCommandOpencode(): Promise<void> {
  console.log("\n[6c] buildTarCommand() - opencode (XDG dirs)");

  const cmd = buildTarCommand("opencode", "/home/user/workspace");

  assert(cmd.includes("workspace/"), "Includes workspace/ directory");
  // OpenCode uses checkpointDirs (XDG Base Directory spec)
  assert(cmd.includes(".local/share/opencode/"), "Includes .local/share/opencode/ (data: sessions, auth)");
  assert(cmd.includes(".config/opencode/"), "Includes .config/opencode/ (config, AGENTS.md)");
  assert(cmd.includes(".local/state/opencode/"), "Includes .local/state/opencode/ (prompt history, prefs)");
  // Should NOT include "./" (the mcpConfig.settingsDir) — checkpointDirs overrides it
  assert(!cmd.includes("'./'"), "Does not include './' (mcpConfig.settingsDir overridden by checkpointDirs)");
}

// =============================================================================
// TESTS: Cache excludes in tar command
// =============================================================================

async function testTarExcludes(): Promise<void> {
  console.log("\n[7] buildTarCommand() - Cache Excludes");

  const cmd = buildTarCommand("claude", "/home/user/workspace");

  // Standard cache excludes
  assert(cmd.includes("--exclude='node_modules'"), "Excludes node_modules");
  assert(cmd.includes("--exclude='__pycache__'"), "Excludes __pycache__");
  assert(cmd.includes("--exclude='*.pyc'"), "Excludes *.pyc");
  assert(cmd.includes("--exclude='.cache'"), "Excludes .cache");
  assert(cmd.includes("--exclude='.npm'"), "Excludes .npm");
  assert(cmd.includes("--exclude='.pip'"), "Excludes .pip");
  assert(cmd.includes("--exclude='.venv'"), "Excludes .venv");
  assert(cmd.includes("--exclude='venv'"), "Excludes venv");

  // Workspace-specific temp exclude
  assert(cmd.includes("--exclude='workspace/temp'"), "Excludes workspace/temp");
}

// =============================================================================
// TESTS: Custom working directory
// =============================================================================

async function testCustomWorkingDir(): Promise<void> {
  console.log("\n[8] buildTarCommand() - Custom Working Directory");

  const cmd = buildTarCommand("claude", "/home/user/myproject");

  assert(cmd.includes("myproject/"), "Uses custom workspace dir");
  assert(cmd.includes("--exclude='myproject/temp'"), "Temp exclude uses custom dir");
  assert(cmd.includes(".claude/"), "Still includes agent settings dir");
}

// =============================================================================
// TESTS: Invalid working directory
// =============================================================================

async function testInvalidWorkingDir(): Promise<void> {
  console.log("\n[9] buildTarCommand() - Invalid Working Directory");

  await assertThrows(
    () => buildTarCommand("claude", "/opt/workspace"),
    "Must start with /home/user/",
    "workingDir not under /home/user/ throws"
  );
}

// =============================================================================
// TESTS: Shell escaping in tar command
// =============================================================================

async function testShellEscaping(): Promise<void> {
  console.log("\n[11] buildTarCommand() - Shell Escaping");

  // Path with a single quote should be escaped, not break the command
  const cmd = buildTarCommand("claude", "/home/user/my'project");

  // shellEscape("my'project/") → 'my'\''project/'
  assert(cmd.includes("'my'\\''project/'"), "Single quote in workspace dir is escaped");
  assert(cmd.includes(".claude/"), "Agent dir still present");
  assert(cmd.includes("sha256sum"), "Command structure intact");
}

// =============================================================================
// TESTS: Invalid agent type
// =============================================================================

async function testInvalidAgentType(): Promise<void> {
  console.log("\n[10] buildTarCommand() - Invalid Agent Type");

  await assertThrows(
    // @ts-expect-error testing invalid input
    () => buildTarCommand("nonexistent", "/home/user/workspace"),
    "Unknown agent type",
    "Invalid agent type throws"
  );
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Checkpoint Tar & Path Normalization Unit Tests");
  console.log("=".repeat(60));

  await testNormalizeAgentDir();
  await testNormalizeWorkspaceDir();
  await testBuildTarCommandClaude();
  await testBuildTarCommandCodex();
  await testBuildTarCommandGemini();
  await testBuildTarCommandQwen();
  await testBuildTarCommandKimi();
  await testBuildTarCommandOpencode();
  await testTarExcludes();
  await testCustomWorkingDir();
  await testInvalidWorkingDir();
  await testShellEscaping();
  await testInvalidAgentType();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
