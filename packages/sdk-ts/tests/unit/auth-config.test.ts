#!/usr/bin/env tsx
/**
 * Unit Test: BYOK (Bring Your Own Key) Auth Configuration
 *
 * Tests resolveAgentConfig() priority levels:
 *   Explicit config (always respected):
 *     1. oauthToken → OAuth direct mode (Claude only)
 *     2. providerApiKey → direct mode
 *     3. apiKey → gateway mode
 *   Environment variables (gateway first for revenue):
 *     4. EVOLVE_API_KEY → gateway mode
 *     5. Provider env var → direct mode
 *     6. OAuth env var → OAuth direct mode (Claude only)
 *
 * Tests resolveDefaultSandbox() priority:
 *   1. EVOLVE_API_KEY → gateway mode (revenue)
 *   2. E2B_API_KEY → direct E2B
 *
 * Usage:
 *   npx tsx tests/unit/auth-config.test.ts
 */

import { resolveAgentConfig } from "../../src/utils/config.js";
import { resolveDefaultSandbox } from "../../src/utils/sandbox.js";
import { getE2BGatewayUrl } from "../../src/constants.js";

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
  const isEqual = actual === expected;
  if (isEqual) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${expected}`);
    console.log(`      Actual:   ${actual}`);
  }
}

function assertThrows(fn: () => void, expectedSubstring: string, message: string): void {
  try {
    fn();
    failed++;
    console.log(`  ✗ ${message} (did not throw)`);
  } catch (e) {
    const error = e as Error;
    if (error.message.includes(expectedSubstring)) {
      passed++;
      console.log(`  ✓ ${message}`);
    } else {
      failed++;
      console.log(`  ✗ ${message} (wrong error message)`);
      console.log(`      Expected substring: ${expectedSubstring}`);
      console.log(`      Actual message: ${error.message}`);
    }
  }
}

async function assertRejects(fn: () => Promise<unknown>, expectedSubstring: string, message: string): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  ✗ ${message} (did not throw)`);
  } catch (e) {
    const error = e as Error;
    if (error.message.includes(expectedSubstring)) {
      passed++;
      console.log(`  ✓ ${message}`);
    } else {
      failed++;
      console.log(`  ✗ ${message} (wrong error message)`);
      console.log(`      Expected substring: ${expectedSubstring}`);
      console.log(`      Actual message: ${error.message}`);
    }
  }
}

// Store original env
const originalEnv = { ...process.env };

function clearEnv(): void {
  delete process.env.EVOLVE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GEMINI_BASE_URL;
  delete process.env.E2B_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

function restoreEnv(): void {
  process.env = { ...originalEnv };
}

// =============================================================================
// TESTS
// =============================================================================

async function runTests(): Promise<void> {
  console.log("\n=== Auth Config Unit Tests ===\n");

  // ─────────────────────────────────────────────────────────────────────────
  // EXPLICIT CONFIG TESTS (always take priority)
  // ─────────────────────────────────────────────────────────────────────────

  console.log("Explicit: oauthToken (OAuth direct mode - Claude only)");

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      oauthToken: "oauth-claude-max-token",
    });
    assertEqual(result.apiKey, "oauth-claude-max-token", "uses oauthToken for Claude");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
    assertEqual(result.isOAuth, true, "isOAuth is true");
    assertEqual(result.type, "claude", "type is claude");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      oauthToken: "oauth-token",
      model: "sonnet",
    });
    assertEqual(result.model, "sonnet", "passes through model option with oauthToken");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      oauthToken: "oauth-token",
      providerApiKey: "sk-ant-direct-key",
      apiKey: "evolve-key",
    });
    assertEqual(result.apiKey, "oauth-token", "oauthToken takes priority over providerApiKey and apiKey");
    assertEqual(result.isOAuth, true, "isOAuth is true");
  }

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "codex", oauthToken: "oauth-token" }),
    "oauthToken is only supported for claude",
    "throws when oauthToken used with codex"
  );

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "gemini", oauthToken: "oauth-token" }),
    "oauthToken is only supported for claude",
    "throws when oauthToken used with gemini"
  );

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "qwen", oauthToken: "oauth-token" }),
    "oauthToken is only supported for claude",
    "throws when oauthToken used with qwen"
  );

  // -------------------------------------------------------------------------
  console.log("\nExplicit: providerApiKey (direct mode)");
  // -------------------------------------------------------------------------

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      providerApiKey: "sk-ant-direct-key",
    });
    assertEqual(result.apiKey, "sk-ant-direct-key", "uses providerApiKey");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
    assertEqual(result.type, "claude", "type is claude");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      providerApiKey: "sk-ant-direct-key",
      providerBaseUrl: "https://custom.anthropic.com",
    });
    assertEqual(result.baseUrl, "https://custom.anthropic.com", "uses explicit providerBaseUrl");
  }

  clearEnv();
  process.env.ANTHROPIC_BASE_URL = "https://env.anthropic.com";
  {
    const result = resolveAgentConfig({
      type: "claude",
      providerApiKey: "sk-ant-direct-key",
    });
    assertEqual(result.baseUrl, "https://env.anthropic.com", "uses env baseUrl when providerBaseUrl not provided");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "qwen",
      providerApiKey: "qwen-direct-key",
    });
    assertEqual(result.baseUrl, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "uses registry defaultBaseUrl for Qwen");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      providerApiKey: "sk-ant-direct-key",
      model: "opus",
    });
    assertEqual(result.model, "opus", "passes through model option");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "codex",
      providerApiKey: "openai-key",
      reasoningEffort: "high",
    });
    assertEqual(result.reasoningEffort, "high", "passes through reasoningEffort option");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      providerApiKey: "sk-ant-direct-key",
    });
    assertEqual(result.apiKey, "sk-ant-direct-key", "providerApiKey path resolves correctly");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      apiKey: "evolve-gateway-key",
      providerApiKey: "sk-ant-direct-key",
    });
    assertEqual(result.apiKey, "sk-ant-direct-key", "providerApiKey takes priority over apiKey");
    assertEqual(result.isDirectMode, true, "isDirectMode is true when providerApiKey present");
  }

  clearEnv();
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  {
    const result = resolveAgentConfig({
      type: "claude",
      providerApiKey: "sk-ant-direct-key",
    });
    assertEqual(result.apiKey, "sk-ant-direct-key", "providerApiKey takes priority over env vars");
  }

  // -------------------------------------------------------------------------
  console.log("\nExplicit: apiKey (gateway mode)");
  // -------------------------------------------------------------------------

  clearEnv();
  {
    const result = resolveAgentConfig({
      type: "claude",
      apiKey: "evolve-gateway-key",
    });
    assertEqual(result.apiKey, "evolve-gateway-key", "uses apiKey for gateway mode");
    assertEqual(result.isDirectMode, false, "isDirectMode is false");
    assert(result.baseUrl === undefined, "baseUrl is undefined in gateway mode");
  }

  clearEnv();
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  {
    const result = resolveAgentConfig({
      type: "claude",
      apiKey: "explicit-gateway-key",
    });
    assertEqual(result.apiKey, "explicit-gateway-key", "apiKey takes priority over env vars");
    assertEqual(result.isDirectMode, false, "isDirectMode is false");
  }

  clearEnv();
  for (const type of ["claude", "codex", "gemini", "qwen"] as const) {
    const result = resolveAgentConfig({
      type,
      apiKey: `gateway-key-${type}`,
    });
    assertEqual(result.apiKey, `gateway-key-${type}`, `gateway mode works for ${type}`);
    assertEqual(result.type, type, `type is ${type}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENVIRONMENT VARIABLE TESTS (gateway takes priority for revenue)
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\nEnv: EVOLVE_API_KEY (gateway mode - highest priority)");

  clearEnv();
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  {
    const result = resolveAgentConfig({ type: "claude" });
    assertEqual(result.apiKey, "env-evolve-key", "uses EVOLVE_API_KEY for gateway mode");
    assertEqual(result.isDirectMode, false, "isDirectMode is false");
  }

  clearEnv();
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  {
    const result = resolveAgentConfig();
    assertEqual(result.apiKey, "env-evolve-key", "works with empty config");
    assertEqual(result.type, "claude", "defaults to claude");
    assertEqual(result.isDirectMode, false, "isDirectMode is false");
  }

  clearEnv();
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  {
    const result = resolveAgentConfig({
      type: "codex",
      model: "gpt-5.2",
      reasoningEffort: "high",
    });
    assertEqual(result.model, "gpt-5.2", "preserves model in gateway mode");
    assertEqual(result.reasoningEffort, "high", "preserves reasoningEffort in gateway mode");
  }

  // EVOLVE_API_KEY takes priority over provider env vars
  clearEnv();
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  {
    const result = resolveAgentConfig({ type: "claude" });
    assertEqual(result.apiKey, "env-evolve-key", "EVOLVE_API_KEY takes priority over ANTHROPIC_API_KEY");
    assertEqual(result.isDirectMode, false, "isDirectMode is false (gateway mode)");
  }

  // EVOLVE_API_KEY takes priority over OAuth env var
  clearEnv();
  process.env.EVOLVE_API_KEY = "env-evolve-key";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
  {
    const result = resolveAgentConfig({ type: "claude" });
    assertEqual(result.apiKey, "env-evolve-key", "EVOLVE_API_KEY takes priority over CLAUDE_CODE_OAUTH_TOKEN");
    assertEqual(result.isDirectMode, false, "isDirectMode is false (gateway mode)");
  }

  // -------------------------------------------------------------------------
  console.log("\nEnv: Provider API key (direct mode - fallback)");
  // -------------------------------------------------------------------------

  clearEnv();
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  {
    const result = resolveAgentConfig({ type: "claude" });
    assertEqual(result.apiKey, "env-anthropic-key", "uses ANTHROPIC_API_KEY for Claude");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
  }

  clearEnv();
  process.env.OPENAI_API_KEY = "env-openai-key";
  {
    const result = resolveAgentConfig({ type: "codex" });
    assertEqual(result.apiKey, "env-openai-key", "uses OPENAI_API_KEY for Codex");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
  }

  clearEnv();
  process.env.GEMINI_API_KEY = "env-gemini-key";
  {
    const result = resolveAgentConfig({ type: "gemini" });
    assertEqual(result.apiKey, "env-gemini-key", "uses GEMINI_API_KEY for Gemini");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
  }

  clearEnv();
  process.env.OPENAI_API_KEY = "env-openai-key";
  {
    const result = resolveAgentConfig({ type: "qwen" });
    assertEqual(result.apiKey, "env-openai-key", "uses OPENAI_API_KEY for Qwen");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
    assertEqual(result.baseUrl, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "Qwen uses registry defaultBaseUrl");
  }

  clearEnv();
  process.env.ANTHROPIC_API_KEY = "env-anthropic-key";
  process.env.ANTHROPIC_BASE_URL = "https://custom.anthropic.com";
  {
    const result = resolveAgentConfig({ type: "claude" });
    assertEqual(result.baseUrl, "https://custom.anthropic.com", "uses baseUrl from env var");
  }

  // -------------------------------------------------------------------------
  console.log("\nEnv: CLAUDE_CODE_OAUTH_TOKEN (OAuth direct mode - lowest priority)");
  // -------------------------------------------------------------------------

  clearEnv();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
  {
    const result = resolveAgentConfig({ type: "claude" });
    assertEqual(result.apiKey, "env-oauth-token", "uses CLAUDE_CODE_OAUTH_TOKEN env var");
    assertEqual(result.isDirectMode, true, "isDirectMode is true");
    assertEqual(result.isOAuth, true, "isOAuth is true");
  }

  clearEnv();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-oauth-token";
  // For codex, CLAUDE_CODE_OAUTH_TOKEN should be ignored (it's not in registry.oauthEnv for codex)
  // This should fall through and throw since no codex API key is set
  assertThrows(
    () => resolveAgentConfig({ type: "codex" }),
    "No API key found for codex",
    "CLAUDE_CODE_OAUTH_TOKEN is ignored for non-claude agents"
  );

  // ─────────────────────────────────────────────────────────────────────────
  // ERROR CASES
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\nError cases");

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "claude" }),
    "No API key found for claude",
    "throws when no API key available"
  );

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "claude" }),
    "oauthToken, or CLAUDE_CODE_OAUTH_TOKEN",
    "error message mentions oauthToken for Claude"
  );

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "claude" }),
    "CLAUDE_CODE_OAUTH_TOKEN",
    "error message mentions CLAUDE_CODE_OAUTH_TOKEN env var for Claude"
  );

  clearEnv();
  assertThrows(
    () => resolveAgentConfig({ type: "codex" }),
    "No API key found for codex",
    "error message specifies agent type"
  );

  clearEnv();
  // For non-claude agents, error should NOT mention oauthToken
  try {
    resolveAgentConfig({ type: "codex" });
  } catch (e) {
    const msg = (e as Error).message;
    assert(!msg.includes("oauthToken"), "error message does NOT mention oauthToken for codex");
    assert(!msg.includes("CLAUDE_CODE_OAUTH_TOKEN"), "error message does NOT mention CLAUDE_CODE_OAUTH_TOKEN for codex");
  }

  clearEnv();
  assertThrows(
    () => resolveAgentConfig(),
    "No API key found",
    "throws with empty config and no env vars"
  );

  // -------------------------------------------------------------------------
  console.log("\nDefault agent type");
  // -------------------------------------------------------------------------

  clearEnv();
  process.env.EVOLVE_API_KEY = "test-key";
  {
    const result = resolveAgentConfig();
    assertEqual(result.type, "claude", "defaults to claude when type not specified");
  }

  clearEnv();
  {
    const result = resolveAgentConfig({ apiKey: "test-key" });
    assertEqual(result.type, "claude", "defaults to claude with explicit apiKey");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // E2B SANDBOX RESOLUTION
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\n=== E2B Sandbox Resolution ===\n");

  console.log("EVOLVE_API_KEY (gateway mode - highest priority)");

  clearEnv();
  delete process.env.E2B_API_URL;
  process.env.EVOLVE_API_KEY = "evolve-gateway-key";
  {
    const provider = await resolveDefaultSandbox();
    assert(provider !== null, "returns a provider");
    assertEqual(provider.providerType, "e2b", "provider type is e2b");
    assertEqual(process.env.E2B_API_URL, getE2BGatewayUrl(), "sets E2B_API_URL for gateway routing");
  }

  // EVOLVE_API_KEY takes priority over E2B_API_KEY
  clearEnv();
  delete process.env.E2B_API_URL;
  process.env.EVOLVE_API_KEY = "evolve-gateway-key";
  process.env.E2B_API_KEY = "e2b-direct-key";
  {
    const provider = await resolveDefaultSandbox();
    assertEqual(provider.providerType, "e2b", "returns e2b provider");
    assertEqual(process.env.E2B_API_URL, undefined, "E2B_API_URL stays unset (direct E2B wins over gateway)");
  }

  // -------------------------------------------------------------------------
  console.log("\nE2B_API_KEY (direct E2B mode - fallback)");
  // -------------------------------------------------------------------------

  clearEnv();
  delete process.env.E2B_API_URL;
  process.env.E2B_API_KEY = "e2b-direct-key";
  {
    const provider = await resolveDefaultSandbox();
    assert(provider !== null, "returns a provider");
    assertEqual(provider.providerType, "e2b", "provider type is e2b");
    assert(process.env.E2B_API_URL === undefined, "E2B_API_URL not set in direct mode");
  }

  // -------------------------------------------------------------------------
  console.log("\nError cases (sandbox)");
  // -------------------------------------------------------------------------

  clearEnv();
  delete process.env.E2B_API_URL;
  await assertRejects(
    () => resolveDefaultSandbox(),
    "No sandbox provider configured",
    "throws when no sandbox keys available"
  );

  // Restore env
  restoreEnv();

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────

  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
