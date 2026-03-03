#!/usr/bin/env tsx
/**
 * Unit Test: Cost API
 *
 * Covers:
 * - getSessionCost() payload normalization
 * - getRunCost() by runId and by index
 * - previous session tag fallback (post-kill query path)
 */

import { Agent } from "../../dist/index.js";
import { writeCodexSpendProvider, writeKimiSpendConfig } from "../../src/mcp/toml.js";
import { writeJsonSpendHeaders } from "../../src/mcp/json.js";

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
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${message}`);
    return;
  }
  failed++;
  console.log(`  ✗ ${message}`);
  console.log(`      Expected: ${String(expected)}`);
  console.log(`      Actual:   ${String(actual)}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createAgent(): Agent {
  const config = {
    type: "claude",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  return new Agent(config as any, {});
}

async function testSessionCostNormalization(): Promise<void> {
  console.log("\n[1] getSessionCost() normalizes run metadata");
  const agent = createAgent();
  (agent as any).previousSessionTag = "evolve-prev-session";

  const originalFetch = globalThis.fetch;
  let lastUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastUrl = String(input);
    return jsonResponse({
      sessionTag: "evolve-prev-session",
      totalCost: 1.2345,
      totalTokens: { prompt: 100, completion: 50 },
      runs: [
        {
          runId: "run-1",
          index: 1,
          cost: 1.2345,
          tokens: { prompt: 100, completion: 50 },
          model: "claude-opus-4-6",
          requests: 2,
        },
      ],
      asOf: "2026-02-25T00:00:00.000Z",
      isComplete: true,
      truncated: false,
    });
  }) as typeof fetch;

  try {
    const session = await agent.getSessionCost();
    assert(lastUrl.includes("tag=evolve-prev-session"), "uses previous session tag when no active session");
    assertEqual(session.runs[0].asOf, "2026-02-25T00:00:00.000Z", "fills run.asOf from session response");
    assertEqual(session.runs[0].isComplete, true, "fills run.isComplete from session response");
    assertEqual(session.runs[0].truncated, false, "fills run.truncated from session response");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testRunCostSelectors(): Promise<void> {
  console.log("\n[2] getRunCost() supports runId and index selectors");
  const agent = createAgent();
  (agent as any).previousSessionTag = "evolve-prev-session";

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const queue: Response[] = [
    // runId selector response (missing metadata fields on purpose)
    jsonResponse({
      runId: "run-abc",
      index: 1,
      cost: 0.42,
      tokens: { prompt: 10, completion: 5 },
      model: "claude-sonnet-4-5-20250929",
      requests: 1,
    }),
    // index selector -> session response
    jsonResponse({
      sessionTag: "evolve-prev-session",
      totalCost: 1.0,
      totalTokens: { prompt: 30, completion: 10 },
      runs: [
        {
          runId: "run-1",
          index: 1,
          cost: 0.4,
          tokens: { prompt: 10, completion: 4 },
          model: "claude-sonnet-4-5-20250929",
          requests: 1,
        },
        {
          runId: "run-2",
          index: 2,
          cost: 0.6,
          tokens: { prompt: 20, completion: 6 },
          model: "claude-opus-4-6",
          requests: 1,
        },
      ],
      asOf: "2026-02-25T01:00:00.000Z",
      isComplete: false,
      truncated: true,
    }),
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("No queued response");
    return next;
  }) as typeof fetch;

  try {
    const byRunId = await agent.getRunCost({ runId: "run-abc" });
    assert(urls[0].includes("runId=run-abc"), "runId selector sends runId query param");
    assertEqual(byRunId.runId, "run-abc", "returns requested runId payload");
    assertEqual(byRunId.isComplete, false, "runId fallback defaults isComplete when missing");
    assertEqual(byRunId.truncated, false, "runId fallback defaults truncated when missing");

    const byIndex = await agent.getRunCost({ index: -1 });
    assertEqual(byIndex.runId, "run-2", "negative index resolves from end");
    assertEqual(byIndex.asOf, "2026-02-25T01:00:00.000Z", "index selector inherits normalized metadata");
    assertEqual(byIndex.truncated, true, "index selector preserves session truncated flag");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testNoActivitySessionSwitchDoesNotClobberTag(): Promise<void> {
  console.log("\n[3] setSession()/kill() without local activity keeps prior spend tag");
  const agent = createAgent();
  (agent as any).previousSessionTag = "evolve-prev-session";
  (agent as any).sessionTag = "evolve-current-session";

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return jsonResponse({
      sessionTag: "evolve-prev-session",
      totalCost: 0,
      totalTokens: { prompt: 0, completion: 0 },
      runs: [],
      asOf: "2026-02-25T02:00:00.000Z",
      isComplete: false,
      truncated: false,
    });
  }) as typeof fetch;

  try {
    // No local run() happened on this switched session
    await agent.setSession("sandbox-switched");
    await agent.getSessionCost();

    // Still no local run() before kill()
    await agent.kill();
    await agent.getSessionCost();

    assert(urls[0].includes("tag=evolve-prev-session"), "setSession() without activity keeps prior tag");
    assert(urls[1].includes("tag=evolve-prev-session"), "kill() without activity keeps prior tag");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCustomHeaderMergeHandlesNewlineFormat(): Promise<void> {
  console.log("\n[4] mergeCustomHeaders() preserves newline-delimited user headers");
  const agent = createAgent() as any;
  agent.sessionTag = "evolve-session";
  agent.options = {
    secrets: {
      ANTHROPIC_CUSTOM_HEADERS: "x-custom-one: foo\nx-custom-two: bar",
    },
  };

  const envs = agent.buildRunEnvs("run-xyz") as Record<string, string> | undefined;
  const headers = envs?.ANTHROPIC_CUSTOM_HEADERS || "";
  const lines = headers.split("\n").map((l: string) => l.trim()).filter(Boolean);

  assert(lines.some((l: string) => l === "x-custom-one: foo"), "keeps first user header as separate line");
  assert(lines.some((l: string) => l === "x-custom-two: bar"), "keeps second user header as separate line");
  assert(lines.some((l: string) => l === "x-litellm-customer-id: evolve-session"), "injects customer-id");
  assert(lines.some((l: string) => l === "x-litellm-tags: run:run-xyz"), "injects run tag");
}

async function testTagAppendBehavior(): Promise<void> {
  console.log("\n[5] mergeCustomHeaders() appends to existing x-litellm-tags");
  const agent = createAgent() as any;
  agent.sessionTag = "evolve-session";
  agent.options = {
    secrets: {
      ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: project:acme,env:prod\nx-custom-one: keep-me",
    },
  };

  const envs = agent.buildRunEnvs("run-xyz") as Record<string, string> | undefined;
  const headers = envs?.ANTHROPIC_CUSTOM_HEADERS || "";
  const lines = headers.split("\n").map((l: string) => l.trim()).filter(Boolean);

  const tagLine = lines.find((l: string) => l.startsWith("x-litellm-tags:"));
  assert(!!tagLine, "has x-litellm-tags line");
  assert(tagLine!.includes("project:acme"), "preserves user tag project:acme");
  assert(tagLine!.includes("env:prod"), "preserves user tag env:prod");
  assert(tagLine!.includes("run:run-xyz"), "appends SDK run tag");
  assert(lines.some((l: string) => l === "x-custom-one: keep-me"), "keeps other user headers");
}

async function testCodexSpendTrackingEnvs(): Promise<void> {
  console.log("\n[6] buildRunEnvs() uses spendTrackingEnvs for Codex-style agents");
  const config = {
    type: "codex",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-codex-session";

  const envs = (agent as any).buildRunEnvs("run-codex-123") as Record<string, string> | undefined;
  assert(!!envs, "returns env overrides");
  assertEqual(envs?.EVOLVE_LITELLM_CUSTOMER_ID, "evolve-codex-session", "session tag env set");
  assertEqual(envs?.EVOLVE_LITELLM_TAGS, "run:run-codex-123", "run tag env set");

  // Verify no ANTHROPIC_CUSTOM_HEADERS (that's Claude-only)
  assert(!envs?.ANTHROPIC_CUSTOM_HEADERS, "no ANTHROPIC_CUSTOM_HEADERS for codex");
}

// =============================================================================
// Fake sandbox for writeCodexSpendProvider tests
// =============================================================================

function createFakeSandbox(existingContent?: string): { sandbox: any; written: { path: string; content: string }[] } {
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      read: async () => {
        if (existingContent === undefined) throw Object.assign(new Error("not found"), { code: "ENOENT" });
        return existingContent;
      },
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };
  return { sandbox, written };
}

const spendEnvs = { sessionTagEnv: "EVOLVE_LITELLM_CUSTOMER_ID", runTagEnv: "EVOLVE_LITELLM_TAGS" };

async function testTomlFreshConfig(): Promise<void> {
  console.log("\n[7] writeCodexSpendProvider() on empty config");
  const { sandbox, written } = createFakeSandbox(undefined);
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  assertEqual(written.length, 1, "writes config file");
  const content = written[0].content;
  assert(content.startsWith('model_provider = "evolve-gateway"'), "root key is first line");
  assert(content.includes("[model_providers.evolve-gateway]"), "has provider section");
  assert(content.includes('base_url = "https://gateway.example.com"'), "has base_url");
  assert(content.includes("EVOLVE_LITELLM_CUSTOMER_ID"), "has session tag env");
  assert(content.includes("EVOLVE_LITELLM_TAGS"), "has run tag env");
}

async function testTomlExistingMcpConfig(): Promise<void> {
  console.log("\n[8] writeCodexSpendProvider() preserves existing MCP sections");
  const existing = `[mcp_servers]\n\n[mcp_servers.browser-use]\nurl = "https://browser.example.com"\n`;
  const { sandbox, written } = createFakeSandbox(existing);
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  const content = written[0].content;
  // Root key must appear before any [section] header
  const rootKeyIdx = content.indexOf('model_provider = "evolve-gateway"');
  const firstSectionIdx = content.search(/^\[/m);
  assert(rootKeyIdx >= 0, "root key present");
  assert(rootKeyIdx < firstSectionIdx, "root key appears before first section");
  assert(content.includes("[mcp_servers.browser-use]"), "preserves existing MCP section");
  assert(content.includes("[model_providers.evolve-gateway]"), "adds provider section");
}

async function testTomlSkipsWhenAlreadyCorrect(): Promise<void> {
  console.log("\n[9] writeCodexSpendProvider() skips when fully configured");
  const existing = [
    'model_provider = "evolve-gateway"',
    "",
    "[mcp_servers]",
    "",
    "[model_providers.evolve-gateway]",
    'name = "Evolve Gateway"',
    'base_url = "https://gateway.example.com"',
    "",
  ].join("\n");
  const { sandbox, written } = createFakeSandbox(existing);
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  assertEqual(written.length, 0, "no write when already configured");
}

async function testTomlDuplicateRootKeyPrevention(): Promise<void> {
  console.log("\n[10] writeCodexSpendProvider() replaces existing model_provider root key");
  const existing = [
    'model_provider = "openai"',
    "",
    "[mcp_servers]",
    "",
  ].join("\n");
  const { sandbox, written } = createFakeSandbox(existing);
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  const content = written[0].content;
  const matches = content.match(/^model_provider\s*=/gm) || [];
  assertEqual(matches.length, 1, "exactly one model_provider key");
  assert(content.includes('"evolve-gateway"'), "key points to evolve-gateway");
}

async function testTomlProfileScopedKeyNotConfused(): Promise<void> {
  console.log("\n[11] writeCodexSpendProvider() ignores profile-scoped model_provider");
  // model_provider inside [profiles.fast] should NOT satisfy the root-key check
  const existing = [
    "[profiles.fast]",
    'model_provider = "evolve-gateway"',
    "",
  ].join("\n");
  const { sandbox, written } = createFakeSandbox(existing);
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  const content = written[0].content;
  // Must add a root-level model_provider since the existing one is profile-scoped
  const rootKeyIdx = content.indexOf('model_provider = "evolve-gateway"');
  const firstSectionIdx = content.search(/^\[/m);
  assert(rootKeyIdx >= 0 && rootKeyIdx < firstSectionIdx, "adds root-level key before sections");
  assert(content.includes("[model_providers.evolve-gateway]"), "adds provider section");
}

// =============================================================================
// Gemini spend tracking (comma-separated custom headers)
// =============================================================================

async function testGeminiBuildRunEnvsCommaFormat(): Promise<void> {
  console.log("\n[13] buildRunEnvs() uses comma-separated format for Gemini");
  const config = {
    type: "gemini",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-gemini-session";

  const envs = (agent as any).buildRunEnvs("run-gem-456") as Record<string, string> | undefined;
  assert(!!envs, "returns env overrides");
  assert(!!envs?.GEMINI_CLI_CUSTOM_HEADERS, "sets GEMINI_CLI_CUSTOM_HEADERS");

  const headers = envs!.GEMINI_CLI_CUSTOM_HEADERS;
  // Comma-separated format: "key: value, key2: value2"
  assert(!headers.includes("\n"), "no newlines in comma format");
  assert(headers.includes("x-litellm-customer-id: evolve-gemini-session"), "has customer-id");
  assert(headers.includes("x-litellm-tags: run:run-gem-456"), "has run tag");

  // Verify it does NOT set ANTHROPIC_CUSTOM_HEADERS
  assert(!envs?.ANTHROPIC_CUSTOM_HEADERS, "no ANTHROPIC_CUSTOM_HEADERS for gemini");
}

async function testGeminiCommaFormatPreservesUserHeaders(): Promise<void> {
  console.log("\n[14] mergeCustomHeaders() comma format preserves user-supplied headers");
  const config = {
    type: "gemini",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {
    secrets: {
      GEMINI_CLI_CUSTOM_HEADERS: "x-custom-one: foo, x-custom-two: bar",
    },
  });
  (agent as any).sessionTag = "evolve-gemini-session";

  const envs = (agent as any).buildRunEnvs("run-gem-789") as Record<string, string> | undefined;
  const headers = envs!.GEMINI_CLI_CUSTOM_HEADERS;

  assert(headers.includes("x-custom-one: foo"), "keeps first user header");
  assert(headers.includes("x-custom-two: bar"), "keeps second user header");
  assert(headers.includes("x-litellm-customer-id: evolve-gemini-session"), "injects customer-id");
  assert(headers.includes("x-litellm-tags: run:run-gem-789"), "injects run tag");
  assert(!headers.includes("\n"), "still comma-separated (no newlines)");
}

async function testGeminiCommaFormatOverwritesTags(): Promise<void> {
  console.log("\n[15] mergeCustomHeaders() comma format overwrites (not appends) tags to avoid Gemini parser ambiguity");
  const config = {
    type: "gemini",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  // User has existing x-litellm-tags — SDK must overwrite, not append,
  // because appending "run:<id>" would be mis-parsed by Gemini's regex.
  const agent = new Agent(config as any, {
    secrets: {
      GEMINI_CLI_CUSTOM_HEADERS: "x-litellm-tags: project-acme, x-custom: keep",
    },
  });
  (agent as any).sessionTag = "evolve-gemini-session";

  const envs = (agent as any).buildRunEnvs("run-gem-overwrite") as Record<string, string> | undefined;
  const headers = envs!.GEMINI_CLI_CUSTOM_HEADERS;

  // Tags overwritten — user's "project-acme" is replaced by SDK's run tag
  assert(!headers.includes("project-acme"), "user tag overwritten (not appended)");
  assert(headers.includes("x-litellm-tags: run:run-gem-overwrite"), "SDK run tag replaces user tags");
  assert(headers.includes("x-custom: keep"), "other user headers preserved");
}

/**
 * Simulate Gemini CLI's header parser (customHeaderUtils.ts) to verify
 * our output is correctly round-tripped. Catches ambiguity bugs like
 * "run:<id>" being split into a separate header.
 */
function parseAsGeminiCli(envValue: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const entry of envValue.split(/,(?=\s*[^,:]+:)/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep === -1) continue;
    const name = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!name) continue;
    headers[name] = value;
  }
  return headers;
}

async function testGeminiRoundTripThroughParser(): Promise<void> {
  console.log("\n[18] Gemini header output round-trips through Gemini CLI parser without corruption");
  const config = {
    type: "gemini",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };

  // Case 1: basic run envs (no user headers)
  const agent1 = new Agent(config as any, {});
  (agent1 as any).sessionTag = "evolve-session-rt";
  const envs1 = (agent1 as any).buildRunEnvs("run-rt-001") as Record<string, string>;
  const parsed1 = parseAsGeminiCli(envs1.GEMINI_CLI_CUSTOM_HEADERS);
  assertEqual(parsed1["x-litellm-customer-id"], "evolve-session-rt", "round-trip: customer-id intact");
  assertEqual(parsed1["x-litellm-tags"], "run:run-rt-001", "round-trip: run tag intact");
  assert(!parsed1["run"], "round-trip: no spurious 'run' header");

  // Case 2: with user-supplied headers including existing tags
  const agent2 = new Agent(config as any, {
    secrets: {
      GEMINI_CLI_CUSTOM_HEADERS: "x-litellm-tags: user-tag, x-custom: val",
    },
  });
  (agent2 as any).sessionTag = "evolve-session-rt2";
  const envs2 = (agent2 as any).buildRunEnvs("run-rt-002") as Record<string, string>;
  const parsed2 = parseAsGeminiCli(envs2.GEMINI_CLI_CUSTOM_HEADERS);
  assertEqual(parsed2["x-litellm-customer-id"], "evolve-session-rt2", "round-trip2: customer-id intact");
  assertEqual(parsed2["x-litellm-tags"], "run:run-rt-002", "round-trip2: run tag (overwrites user tag)");
  assertEqual(parsed2["x-custom"], "val", "round-trip2: user header preserved");
  assert(!parsed2["run"], "round-trip2: no spurious 'run' header from tag split");

  // Case 3: session-level envs also round-trip
  const envs3 = (agent2 as any).buildEnvironmentVariables() as Record<string, string>;
  const parsed3 = parseAsGeminiCli(envs3.GEMINI_CLI_CUSTOM_HEADERS);
  assertEqual(parsed3["x-litellm-customer-id"], "evolve-session-rt2", "round-trip3: session customer-id");
  assert(!parsed3["run"], "round-trip3: no spurious 'run' header at session level");
}

async function testGeminiBuildEnvVarsSessionLevel(): Promise<void> {
  console.log("\n[16] buildEnvironmentVariables() sets session-level header for Gemini");
  const config = {
    type: "gemini",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-gemini-session";

  const envs = (agent as any).buildEnvironmentVariables() as Record<string, string>;
  assert(!!envs.GEMINI_CLI_CUSTOM_HEADERS, "sets GEMINI_CLI_CUSTOM_HEADERS at session level");
  assert(envs.GEMINI_CLI_CUSTOM_HEADERS.includes("x-litellm-customer-id: evolve-gemini-session"), "session-level customer-id");
  assert(!envs.GEMINI_CLI_CUSTOM_HEADERS.includes("\n"), "comma format at session level");
}

async function testGeminiDirectModeSkipsHeaders(): Promise<void> {
  console.log("\n[17] buildRunEnvs() returns undefined for Gemini in direct mode");
  const config = {
    type: "gemini",
    apiKey: "direct-api-key",
    isDirectMode: true,
  };
  const agent = new Agent(config as any, {});

  const envs = (agent as any).buildRunEnvs("run-direct") as Record<string, string> | undefined;
  assertEqual(envs, undefined, "no env overrides in direct mode");
}

async function testTomlRootKeyDriftRepair(): Promise<void> {
  console.log("\n[12] writeCodexSpendProvider() repairs root key when provider section exists but key drifted");
  const existing = [
    'model_provider = "openai"',
    "",
    "[model_providers.evolve-gateway]",
    'name = "Evolve Gateway"',
    'base_url = "https://gateway.example.com"',
    "",
  ].join("\n");
  const { sandbox, written } = createFakeSandbox(existing);
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  const content = written[0].content;
  const matches = content.match(/^model_provider\s*=/gm) || [];
  assertEqual(matches.length, 1, "exactly one model_provider key after repair");
  assert(content.includes('"evolve-gateway"'), "key repaired to evolve-gateway");
  // Provider section should NOT be duplicated
  const sectionMatches = content.match(/\[model_providers\.evolve-gateway\]/g) || [];
  assertEqual(sectionMatches.length, 1, "provider section not duplicated");
}

// =============================================================================
// Qwen spend tracking (JSON config-file-based customHeaders)
// =============================================================================

async function testQwenWriteJsonSpendHeaders(): Promise<void> {
  console.log("\n[19] writeJsonSpendHeaders() writes headers at correct JSON path");
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      read: async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); },
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };

  await writeJsonSpendHeaders(
    sandbox as any,
    "qwen",
    "model.generationConfig.customHeaders",
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-123" },
  );

  assertEqual(written.length, 1, "writes one file");
  const config = JSON.parse(written[0].content);
  assertEqual(config.model?.generationConfig?.customHeaders?.["x-litellm-customer-id"], "session-abc", "customer-id at correct path");
  assertEqual(config.model?.generationConfig?.customHeaders?.["x-litellm-tags"], "run:run-123", "run tag at correct path");
}

async function testQwenWriteJsonPreservesExistingConfig(): Promise<void> {
  console.log("\n[20] writeJsonSpendHeaders() preserves existing settings (MCP, etc.)");
  const existing = JSON.stringify({
    mcpServers: { myServer: { url: "http://localhost:3000" } },
    model: { generationConfig: { timeout: 30000 } },
  });
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      read: async () => existing,
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };

  await writeJsonSpendHeaders(
    sandbox as any,
    "qwen",
    "model.generationConfig.customHeaders",
    { "x-litellm-customer-id": "session-xyz" },
  );

  const config = JSON.parse(written[0].content);
  // Existing MCP config preserved
  assertEqual(config.mcpServers?.myServer?.url, "http://localhost:3000", "MCP config preserved");
  // Existing generationConfig fields preserved
  assertEqual(config.model?.generationConfig?.timeout, 30000, "timeout preserved");
  // Headers added
  assertEqual(config.model?.generationConfig?.customHeaders?.["x-litellm-customer-id"], "session-xyz", "headers added");
}

async function testQwenBuildRunEnvsReturnsUndefined(): Promise<void> {
  console.log("\n[21] Qwen buildRunEnvs() returns undefined (uses config file, not env vars)");
  const config = {
    type: "qwen",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-qwen-session";

  const envs = (agent as any).buildRunEnvs("run-qwen-001") as Record<string, string> | undefined;
  // Qwen has no customHeadersEnv and no spendTrackingEnvs, so buildRunEnvs returns undefined.
  // Per-run tracking is done via config file write in run(), not via env overrides.
  assertEqual(envs, undefined, "no env overrides for qwen (uses config file)");
}

async function testQwenDirectModeSkipsHeaders(): Promise<void> {
  console.log("\n[22] Qwen direct mode skips config-file headers");
  const config = {
    type: "qwen",
    apiKey: "direct-api-key",
    isDirectMode: true,
  };
  const agent = new Agent(config as any, {});

  const envs = (agent as any).buildRunEnvs("run-direct") as Record<string, string> | undefined;
  assertEqual(envs, undefined, "no env overrides in direct mode");
}

async function testQwenWriteJsonOverwritesPreviousHeaders(): Promise<void> {
  console.log("\n[23] writeJsonSpendHeaders() overwrites previous headers (per-run update)");
  // Simulate first run wrote headers, now second run overwrites
  const afterFirstRun = JSON.stringify({
    model: {
      generationConfig: {
        customHeaders: {
          "x-litellm-customer-id": "session-abc",
          "x-litellm-tags": "run:run-001",
        },
      },
    },
  });
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      read: async () => afterFirstRun,
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };

  await writeJsonSpendHeaders(
    sandbox as any,
    "qwen",
    "model.generationConfig.customHeaders",
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-002" },
  );

  const config = JSON.parse(written[0].content);
  assertEqual(config.model?.generationConfig?.customHeaders?.["x-litellm-tags"], "run:run-002", "run tag updated to run-002");
  assertEqual(config.model?.generationConfig?.customHeaders?.["x-litellm-customer-id"], "session-abc", "session tag unchanged");
}

// =============================================================================
// Kimi spend tracking (dedicated config via --config-file, no merge/parsing)
// =============================================================================

const kimiConfig = {
  configPath: "~/.kimi/evolve-config.toml",
  providerName: "evolve-gateway",
  modelName: "evolve-default",
  maxContextSize: 262144,
};

async function testKimiWriteSpendConfigFresh(): Promise<void> {
  console.log("\n[25] writeKimiSpendConfig() writes deterministic config from scratch");
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };

  await writeKimiSpendConfig(
    sandbox as any,
    kimiConfig,
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-001" },
  );

  assertEqual(written.length, 1, "writes one file");
  assertEqual(written[0].path, "/home/user/.kimi/evolve-config.toml", "writes to dedicated Evolve config path");
  const content = written[0].content;
  assert(content.includes('default_model = "evolve-default"'), "has default_model");
  assert(content.includes("[providers.evolve-gateway]"), "has provider section");
  assert(content.includes('type = "kimi"'), "provider type is kimi");
  assert(content.includes("x-litellm-customer-id"), "has customer-id header");
  assert(content.includes("session-abc"), "has session tag value");
  assert(content.includes("x-litellm-tags"), "has tags header");
  assert(content.includes("run:run-001"), "has run tag value");
  assert(content.includes("[models.evolve-default]"), "has model section");
  assert(content.includes('provider = "evolve-gateway"'), "model points to provider");
  assert(content.includes("max_context_size = 262144"), "model has max_context_size");
}

async function testKimiWriteSpendConfigPerRunOverwrite(): Promise<void> {
  console.log("\n[26] writeKimiSpendConfig() overwrites entirely on second run (no merge)");
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };

  // First run
  await writeKimiSpendConfig(
    sandbox as any,
    kimiConfig,
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-001" },
  );
  // Second run
  await writeKimiSpendConfig(
    sandbox as any,
    kimiConfig,
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-002" },
  );

  assertEqual(written.length, 2, "writes file twice (once per run)");
  const content = written[1].content;
  assert(content.includes("run:run-002"), "second run tag present");
  assert(!content.includes("run:run-001"), "first run tag gone (full overwrite)");
  assert(content.includes("session-abc"), "session tag present");
}

async function testKimiBuildCommandIncludesConfigFile(): Promise<void> {
  console.log("\n[27] Kimi buildCommand() includes --config-file in gateway mode");
  const { AGENT_REGISTRY } = await import("../../src/registry.js");
  const kimi = AGENT_REGISTRY.kimi;

  const gatewayCmd = kimi.buildCommand({
    prompt: "hello",
    model: "moonshot/kimi-k2.5",
    isResume: false,
    isDirectMode: false,
  });
  assert(gatewayCmd.includes("--config-file /home/user/.kimi/evolve-config.toml"), "gateway mode has --config-file");
  assert(gatewayCmd.includes("--print"), "has --print flag");
  assert(gatewayCmd.includes("--yolo"), "has --yolo flag");

  const directCmd = kimi.buildCommand({
    prompt: "hello",
    model: "moonshot/kimi-k2.5",
    isResume: false,
    isDirectMode: true,
  });
  assert(!directCmd.includes("--config-file"), "direct mode omits --config-file");
}

async function testKimiBuildRunEnvsReturnsUndefined(): Promise<void> {
  console.log("\n[28] Kimi buildRunEnvs() returns undefined (uses config file, not env vars)");
  const config = {
    type: "kimi",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-kimi-session";

  const envs = (agent as any).buildRunEnvs("run-kimi-001") as Record<string, string> | undefined;
  assertEqual(envs, undefined, "no env overrides for kimi (uses config file)");
}

async function testKimiDirectModeSkipsHeaders(): Promise<void> {
  console.log("\n[29] Kimi direct mode skips config-file headers");
  const config = {
    type: "kimi",
    apiKey: "direct-api-key",
    isDirectMode: true,
  };
  const agent = new Agent(config as any, {});

  const envs = (agent as any).buildRunEnvs("run-direct") as Record<string, string> | undefined;
  assertEqual(envs, undefined, "no env overrides in direct mode");
}

async function testQwenWriteJsonPreservesUserDefinedHeaders(): Promise<void> {
  console.log("\n[24] writeJsonSpendHeaders() preserves user-defined custom headers (no clobber)");
  // User has already configured their own custom headers in settings.json
  const existing = JSON.stringify({
    model: {
      generationConfig: {
        customHeaders: {
          "x-my-app-id": "user-app-123",
          "x-trace-id": "user-trace-abc",
        },
      },
    },
  });
  const written: { path: string; content: string }[] = [];
  const sandbox = {
    files: {
      makeDir: async () => {},
      read: async () => existing,
      write: async (path: string, content: string) => { written.push({ path, content }); },
    },
  };

  await writeJsonSpendHeaders(
    sandbox as any,
    "qwen",
    "model.generationConfig.customHeaders",
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-001" },
  );

  const config = JSON.parse(written[0].content);
  const headers = config.model?.generationConfig?.customHeaders;
  // User headers preserved
  assertEqual(headers?.["x-my-app-id"], "user-app-123", "user header x-my-app-id preserved");
  assertEqual(headers?.["x-trace-id"], "user-trace-abc", "user header x-trace-id preserved");
  // Spend headers added
  assertEqual(headers?.["x-litellm-customer-id"], "session-abc", "spend customer-id added");
  assertEqual(headers?.["x-litellm-tags"], "run:run-001", "spend run tag added");
}

// =============================================================================
// OpenCode spend tracking (model.headers via OPENCODE_CONFIG_CONTENT env var)
// =============================================================================

async function testOpenCodeBuildRunEnvsIncludesHeaders(): Promise<void> {
  console.log("\n[30] OpenCode buildRunEnvs() returns OPENCODE_CONFIG_CONTENT with spend headers");
  const config = {
    type: "opencode",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-opencode-session";

  const envs = (agent as any).buildRunEnvs("run-oc-001") as Record<string, string> | undefined;
  assert(envs !== undefined, "returns env overrides");
  assert("OPENCODE_CONFIG_CONTENT" in (envs || {}), "has OPENCODE_CONFIG_CONTENT key");

  const parsed = JSON.parse(envs!.OPENCODE_CONFIG_CONTENT);
  const litellm = parsed?.provider?.litellm;
  assert(litellm !== undefined, "has litellm provider");
  assert(litellm.options?.baseURL?.includes("/v1"), "has gateway base URL");

  // Find the model entry (key is the model string)
  const modelKeys = Object.keys(litellm.models || {});
  assert(modelKeys.length === 1, `has one model entry (got ${modelKeys.length})`);
  const modelEntry = litellm.models[modelKeys[0]];
  assertEqual(modelEntry.headers?.["x-litellm-customer-id"], "evolve-opencode-session", "session tag in headers");
  assert(modelEntry.headers?.["x-litellm-tags"]?.includes("run:run-oc-001"), "run tag in headers");
}

async function testOpenCodeBuildRunEnvsPerRunOverwrite(): Promise<void> {
  console.log("\n[31] OpenCode buildRunEnvs() per-run headers change between runs");
  const config = {
    type: "opencode",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-opencode-session";

  const envs1 = (agent as any).buildRunEnvs("run-001") as Record<string, string>;
  const envs2 = (agent as any).buildRunEnvs("run-002") as Record<string, string>;

  const p1 = JSON.parse(envs1.OPENCODE_CONFIG_CONTENT);
  const p2 = JSON.parse(envs2.OPENCODE_CONFIG_CONTENT);
  const m1 = Object.values(p1.provider.litellm.models)[0] as any;
  const m2 = Object.values(p2.provider.litellm.models)[0] as any;

  assert(m1.headers["x-litellm-tags"].includes("run-001"), "run 1 has run-001 tag");
  assert(m2.headers["x-litellm-tags"].includes("run-002"), "run 2 has run-002 tag");
  assertEqual(m1.headers["x-litellm-customer-id"], m2.headers["x-litellm-customer-id"], "session tag same across runs");
}

async function testOpenCodeDirectModeSkipsHeaders(): Promise<void> {
  console.log("\n[32] OpenCode direct mode skips config env override");
  const config = {
    type: "opencode",
    apiKey: "direct-api-key",
    isDirectMode: true,
  };
  const agent = new Agent(config as any, {});

  const envs = (agent as any).buildRunEnvs("run-direct") as Record<string, string> | undefined;
  assertEqual(envs, undefined, "no env overrides in direct mode");
}

async function testOpenCodeMergesUserSecrets(): Promise<void> {
  console.log("\n[33] OpenCode buildRunEnvs() deep-merges with user-provided OPENCODE_CONFIG_CONTENT");
  const userConfig = {
    provider: {
      custom: { npm: "@ai-sdk/custom", options: { baseURL: "https://custom.api/v1" } },
      litellm: {
        npm: "@ai-sdk/openai-compatible",
        models: {
          "openrouter/anthropic/claude-sonnet-4.6": {
            name: "openrouter/anthropic/claude-sonnet-4.6",
            headers: { "x-user-header": "keep-me" },
          },
        },
      },
    },
    theme: "dark",
  };
  const config = {
    type: "opencode",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {
    secrets: { OPENCODE_CONFIG_CONTENT: JSON.stringify(userConfig) },
  });
  (agent as any).sessionTag = "evolve-oc-merge";

  const envs = (agent as any).buildRunEnvs("run-merge-001") as Record<string, string>;
  const parsed = JSON.parse(envs.OPENCODE_CONFIG_CONTENT);

  // User's custom provider preserved
  assert(parsed.provider.custom !== undefined, "custom provider preserved");
  assertEqual(parsed.provider.custom.npm, "@ai-sdk/custom", "custom provider npm preserved");

  // User's non-provider config preserved
  assertEqual(parsed.theme, "dark", "user theme setting preserved");

  // User's existing model header preserved alongside spend headers
  const model = parsed.provider.litellm.models["openrouter/anthropic/claude-sonnet-4.6"];
  assertEqual(model.headers["x-user-header"], "keep-me", "user model header preserved");
  assertEqual(model.headers["x-litellm-customer-id"], "evolve-oc-merge", "spend session header injected");
  assert(model.headers["x-litellm-tags"]?.includes("run:run-merge-001"), "spend run tag injected");

  // SDK overrides litellm options (gateway URL + API key)
  assert(parsed.provider.litellm.options.baseURL.includes("/v1"), "gateway baseURL set");
  assertEqual(parsed.provider.litellm.options.apiKey, "test-gateway-key", "gateway apiKey set");
}

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Cost API Unit Tests");
  console.log("============================================================");
  await testSessionCostNormalization();
  await testRunCostSelectors();
  await testNoActivitySessionSwitchDoesNotClobberTag();
  await testCustomHeaderMergeHandlesNewlineFormat();
  await testTagAppendBehavior();
  await testCodexSpendTrackingEnvs();
  await testTomlFreshConfig();
  await testTomlExistingMcpConfig();
  await testTomlSkipsWhenAlreadyCorrect();
  await testTomlDuplicateRootKeyPrevention();
  await testTomlProfileScopedKeyNotConfused();
  await testTomlRootKeyDriftRepair();
  await testGeminiBuildRunEnvsCommaFormat();
  await testGeminiCommaFormatPreservesUserHeaders();
  await testGeminiCommaFormatOverwritesTags();
  await testGeminiBuildEnvVarsSessionLevel();
  await testGeminiDirectModeSkipsHeaders();
  await testGeminiRoundTripThroughParser();
  await testQwenWriteJsonSpendHeaders();
  await testQwenWriteJsonPreservesExistingConfig();
  await testQwenBuildRunEnvsReturnsUndefined();
  await testQwenDirectModeSkipsHeaders();
  await testQwenWriteJsonOverwritesPreviousHeaders();
  await testQwenWriteJsonPreservesUserDefinedHeaders();
  await testKimiWriteSpendConfigFresh();
  await testKimiWriteSpendConfigPerRunOverwrite();
  await testKimiBuildCommandIncludesConfigFile();
  await testKimiBuildRunEnvsReturnsUndefined();
  await testKimiDirectModeSkipsHeaders();
  await testOpenCodeBuildRunEnvsIncludesHeaders();
  await testOpenCodeBuildRunEnvsPerRunOverwrite();
  await testOpenCodeDirectModeSkipsHeaders();
  await testOpenCodeMergesUserSecrets();
  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
