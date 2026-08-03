#!/usr/bin/env tsx
/**
 * Unit Test: TOML config writers (Codex MCP, Codex gateway provider, Kimi Code)
 *
 * The writers parse the existing document, mutate the object and re-serialize.
 * These tests pin the behaviour that the previous hand-rolled serializer and
 * its regex/substring edits got wrong:
 * - a value containing newlines or quotes must still produce parseable TOML
 * - a commented-out section must never mask the real one
 * - an existing real section must survive untouched
 */

import { parse } from "smol-toml";
import { writeCodexMcpConfig, writeCodexSpendProvider, writeKimiSpendConfig } from "../../src/mcp/toml.ts";
import { getMcpSettingsPath } from "../../src/registry.ts";
import type { SandboxInstance } from "../../src/types.ts";

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
    return;
  }
  failed++;
  console.log(`  ✗ ${message}`);
  console.log(`      Expected: ${String(expected)}`);
  console.log(`      Actual:   ${String(actual)}`);
}

const CODEX_CONFIG = getMcpSettingsPath("codex");

function createFakeSandbox(seed?: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const writes: string[] = [];

  const sandbox = {
    files: {
      makeDir: async () => {},
      read: async (path: string) => {
        if (!files.has(path)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
        return files.get(path) as string;
      },
      write: async (path: string, content: string) => {
        files.set(path, content);
        writes.push(path);
      },
    },
  } as unknown as SandboxInstance;

  return {
    sandbox,
    writes,
    raw: (path: string): string => files.get(path) ?? "",
    doc: (path: string): Record<string, any> => parse(files.get(path) ?? "") as Record<string, any>,
  };
}

// =============================================================================
// Codex MCP config
// =============================================================================

async function testMultiLineEnvStaysValidToml(): Promise<void> {
  console.log("\n[1] multi-line and quoted values keep config.toml parseable");

  const { sandbox, doc } = createFakeSandbox();
  await writeCodexMcpConfig(sandbox, {
    secrets: {
      command: "run-secrets",
      args: ["--stdio"],
      env: {
        PRIVATE_KEY: "-----BEGIN KEY-----\nline-two\n-----END KEY-----",
        QUOTED: 'say "hi"',
        WINDOWS_PATH: "C:\\tools\\bin",
      },
    },
  });

  // parse() throws on the old serializer's raw newline inside a basic string
  const config = doc(CODEX_CONFIG);
  assertEqual(
    config.mcp_servers.secrets.env.PRIVATE_KEY,
    "-----BEGIN KEY-----\nline-two\n-----END KEY-----",
    "multi-line env value round-trips",
  );
  assertEqual(config.mcp_servers.secrets.env.QUOTED, 'say "hi"', "quoted env value round-trips");
  assertEqual(config.mcp_servers.secrets.env.WINDOWS_PATH, "C:\\tools\\bin", "backslash env value round-trips");
  assertEqual(config.mcp_servers.secrets.command, "run-secrets", "stdio command written");
  assertEqual(config.mcp_servers.secrets.args[0], "--stdio", "stdio args written");
}

async function testCommentedSectionDoesNotSuppressServer(): Promise<void> {
  console.log("\n[2] a commented-out section does not suppress the real one");

  const existing = [
    "# The user disabled this server by hand:",
    "# [mcp_servers.docs]",
    '# url = "https://old.example.com"',
    "",
    "# experimental_use_rmcp_client = true",
    "",
  ].join("\n");
  const { sandbox, doc } = createFakeSandbox({ [CODEX_CONFIG]: existing });

  await writeCodexMcpConfig(sandbox, {
    docs: { url: "https://docs.example.com", type: "http" },
  });

  const config = doc(CODEX_CONFIG);
  assertEqual(config.mcp_servers?.docs?.url, "https://docs.example.com", "commented section did not block the write");
  assertEqual(config.experimental_use_rmcp_client, true, "commented flag did not block the real flag");
}

async function testExistingServerIsPreserved(): Promise<void> {
  console.log("\n[3] an existing real server keeps the user's own settings");

  const existing = [
    "experimental_use_rmcp_client = false",
    "",
    "[mcp_servers.docs]",
    'url = "https://user-choice.example.com"',
    "",
    "[mcp_servers.other]",
    'command = "keep-me"',
    "",
  ].join("\n");
  const { sandbox, doc } = createFakeSandbox({ [CODEX_CONFIG]: existing });

  await writeCodexMcpConfig(sandbox, {
    docs: { url: "https://docs.example.com", type: "http" },
    fresh: { command: "new-server" },
  });

  const config = doc(CODEX_CONFIG);
  assertEqual(config.mcp_servers.docs.url, "https://user-choice.example.com", "existing server not overwritten");
  assertEqual(config.mcp_servers.other.command, "keep-me", "unrelated server preserved");
  assertEqual(config.mcp_servers.fresh.command, "new-server", "new server added");
  assertEqual(config.experimental_use_rmcp_client, false, "explicit user flag is not flipped");
}

async function testMalformedConfigFailsLoudly(): Promise<void> {
  console.log("\n[4] a malformed existing config fails with the path");

  const { sandbox } = createFakeSandbox({ [CODEX_CONFIG]: "this is not = = toml\n[[[\n" });
  let message = "";
  try {
    await writeCodexMcpConfig(sandbox, { docs: { url: "https://docs.example.com" } });
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("Failed to parse TOML"), "reports a parse failure");
  assert(message.includes(CODEX_CONFIG), "names the offending file");
}

// =============================================================================
// Codex gateway provider
// =============================================================================

const spendEnvs = { sessionTagEnv: "EVOLVE_LITELLM_CUSTOMER_ID", runTagEnv: "EVOLVE_LITELLM_TAGS" };

async function testSpendProviderCoexistsWithMcpServers(): Promise<void> {
  console.log("\n[5] gateway provider and MCP servers live in one valid document");

  const { sandbox, doc } = createFakeSandbox();
  await writeCodexMcpConfig(sandbox, {
    secrets: { command: "run-secrets", env: { TOKEN: "multi\nline" } },
  });
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  const config = doc(CODEX_CONFIG);
  assertEqual(config.model_provider, "evolve-gateway", "root model_provider set");
  assertEqual(config.model_providers["evolve-gateway"].base_url, "https://gateway.example.com", "gateway base_url set");
  assertEqual(
    config.model_providers["evolve-gateway"].env_http_headers["x-litellm-customer-id"],
    "EVOLVE_LITELLM_CUSTOMER_ID",
    "gateway tracking header set",
  );
  assertEqual(config.mcp_servers.secrets.env.TOKEN, "multi\nline", "MCP server survives the provider write");
}

async function testSpendProviderIsIdempotent(): Promise<void> {
  console.log("\n[6] gateway provider re-write is skipped once the file matches");

  const { sandbox, writes } = createFakeSandbox();
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);
  assertEqual(writes.length, 1, "first call writes");

  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);
  assertEqual(writes.length, 1, "second identical call does not rewrite");

  await writeCodexSpendProvider(sandbox, "https://other-gateway.example.com", spendEnvs);
  assertEqual(writes.length, 2, "changed base_url rewrites");
}

async function testSpendProviderReplacesCommentedProvider(): Promise<void> {
  console.log("\n[7] a commented-out provider section does not mask the real (stale) one");

  // BOTH forms at once: a commented-out section the parser must ignore AND a
  // real section carrying a stale gateway. The write must replace the real
  // one — a substring scan that stopped at the commented text left the stale
  // URL in force.
  const existing = [
    "# [model_providers.evolve-gateway]",
    '# base_url = "https://commented.example.com"',
    "",
    "[model_providers.evolve-gateway]",
    'name = "Evolve Gateway"',
    'base_url = "https://stale.example.com"',
    'env_key = "OPENAI_API_KEY"',
    "",
    "[mcp_servers.docs]",
    'url = "https://docs.example.com"',
    "",
  ].join("\n");
  const { sandbox, doc, raw } = createFakeSandbox({ [CODEX_CONFIG]: existing });
  await writeCodexSpendProvider(sandbox, "https://gateway.example.com", spendEnvs);

  const config = doc(CODEX_CONFIG);
  assertEqual(config.model_providers["evolve-gateway"].base_url, "https://gateway.example.com", "stale real provider replaced");
  assertEqual(config.model_providers["evolve-gateway"].wire_api, "responses", "replacement is the full desired provider");
  assertEqual(config.mcp_servers.docs.url, "https://docs.example.com", "MCP server preserved");

  const content = raw(CODEX_CONFIG);
  assert(!content.includes("stale.example.com"), "no stale base_url survives anywhere in the file");
  const rootKeyIdx = content.indexOf('model_provider = "evolve-gateway"');
  assert(rootKeyIdx >= 0 && rootKeyIdx < content.search(/^\[/m), "root key stays above every section header");
}

async function testNonTableKeyRefusesLoudly(): Promise<void> {
  console.log("\n[7b] a scalar where a table belongs refuses instead of being erased");

  const scalarServers = createFakeSandbox({ [CODEX_CONFIG]: 'mcp_servers = "oops"\n' });
  let message = "";
  try {
    await writeCodexMcpConfig(scalarServers.sandbox, { docs: { url: "https://docs.example.com" } });
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes('"mcp_servers"'), "names the offending key");
  assert(message.includes("found a string"), "names the type it found");
  assert(message.includes(CODEX_CONFIG), "names the file");
  assertEqual(scalarServers.raw(CODEX_CONFIG), 'mcp_servers = "oops"\n', "the user's file is left untouched");

  const arrayProviders = createFakeSandbox({ [CODEX_CONFIG]: "model_providers = [1, 2]\n" });
  let providerMessage = "";
  try {
    await writeCodexSpendProvider(arrayProviders.sandbox, "https://gateway.example.com", spendEnvs);
  } catch (error) {
    providerMessage = (error as Error).message;
  }
  assert(providerMessage.includes('"model_providers"') && providerMessage.includes("found an array"), "provider table refusal is typed too");
}

async function testSpendProviderWithoutTrackingEnvs(): Promise<void> {
  console.log("\n[8] external gateway mode omits env_http_headers");

  const { sandbox, doc } = createFakeSandbox();
  await writeCodexSpendProvider(sandbox, "https://external.example.com");

  const provider = doc(CODEX_CONFIG).model_providers["evolve-gateway"];
  assertEqual(provider.wire_api, "responses", "wire_api pinned to responses");
  assertEqual(provider.env_http_headers, undefined, "no headers table when nothing to track");
}

// =============================================================================
// Kimi Code config
// =============================================================================

async function testKimiConfigRoundTrips(): Promise<void> {
  console.log("\n[9] Kimi Code config round-trips, headers included");

  const { sandbox, doc } = createFakeSandbox();
  await writeKimiSpendConfig(
    sandbox,
    {
      configPath: "~/.kimi-code/config.toml",
      providerName: "evolve-gateway",
      modelName: "evolve-default",
      maxContextSize: 262144,
    },
    { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-001\nnote:\"quoted\"" },
    {
      baseUrl: "https://gateway.test/v1",
      apiKey: "test-gateway-key",
      model: "moonshot/kimi-k2.5",
      defaultThinking: true,
      thinkingEffort: "high",
    },
  );

  const config = doc("/home/user/.kimi-code/config.toml");
  assertEqual(config.default_model, "evolve-default", "default_model set");
  assertEqual(config.thinking.effort, "high", "thinking effort set");
  assertEqual(config.providers["evolve-gateway"].api_key, "test-gateway-key", "gateway api_key set");
  assertEqual(
    config.providers["evolve-gateway"].custom_headers["x-litellm-tags"],
    'run:run-001\nnote:"quoted"',
    "header value with newline and quotes round-trips",
  );
  assertEqual(config.models["evolve-default"].max_context_size, 262144, "max_context_size is an integer");
  assertEqual(config.models["evolve-default"].capabilities.join(","), "image_in,thinking", "capabilities preserved");
}

async function testKimiConfigWithoutThinking(): Promise<void> {
  console.log("\n[10] Kimi Code config with thinking off omits effort");

  const { sandbox, doc } = createFakeSandbox();
  await writeKimiSpendConfig(
    sandbox,
    {
      configPath: "~/.kimi-code/config.toml",
      providerName: "evolve-gateway",
      modelName: "evolve-default",
      maxContextSize: 128000,
    },
    {},
    {
      baseUrl: "https://gateway.test/v1",
      apiKey: "test-gateway-key",
      model: "gpt-5.5",
      defaultThinking: false,
      thinkingEffort: "high",
    },
  );

  const config = doc("/home/user/.kimi-code/config.toml");
  assertEqual(config.default_thinking, false, "default_thinking off");
  assertEqual(config.thinking.mode, "off", "thinking mode off");
  assertEqual(config.thinking.effort, undefined, "effort omitted when thinking is off");
  assertEqual(Object.keys(config.providers["evolve-gateway"].custom_headers).length, 0, "empty headers stay empty");
}

async function main(): Promise<void> {
  console.log("=== TOML Config Writers ===");

  await testMultiLineEnvStaysValidToml();
  await testCommentedSectionDoesNotSuppressServer();
  await testExistingServerIsPreserved();
  await testMalformedConfigFailsLoudly();
  await testSpendProviderCoexistsWithMcpServers();
  await testSpendProviderIsIdempotent();
  await testSpendProviderReplacesCommentedProvider();
  await testNonTableKeyRefusesLoudly();
  await testSpendProviderWithoutTrackingEnvs();
  await testKimiConfigRoundTrips();
  await testKimiConfigWithoutThinking();

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
