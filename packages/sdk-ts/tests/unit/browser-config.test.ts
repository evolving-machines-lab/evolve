#!/usr/bin/env tsx
/**
 * Browser configuration tests
 *
 * Run with:
 *   npx tsx tests/unit/browser-config.test.ts
 */

import { Evolve, type SandboxInstance, type SandboxProvider } from "../../dist/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    console.error(`FAIL: ${message}`);
  } else {
    passed++;
    console.log(`PASS: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

const fakeSandboxProvider: SandboxProvider = {
  providerType: "mock",
  name: "Mock Sandbox",
  async create(): Promise<SandboxInstance> {
    throw new Error("not used");
  },
  async connect(): Promise<SandboxInstance> {
    throw new Error("not used");
  },
};

async function getInitializedMcpServers(kit: Evolve): Promise<Record<string, any>> {
  await (kit as any).initializeAgent();
  return ((kit as any).agent as any).options.mcpServers ?? {};
}

async function getInitializedAgentOptions(kit: Evolve): Promise<Record<string, any>> {
  await (kit as any).initializeAgent();
  return ((kit as any).agent as any).options ?? {};
}

async function testBrowserUseNotInjectedByDefault(): Promise<void> {
  console.log("\n[1] Gateway mode: browser-use is not injected by default");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider);

  const mcpServers = await getInitializedMcpServers(kit);
  assert(!mcpServers["browser-use"], "browser-use MCP absent without withBrowser()");
}

async function testWithBrowserInjectsGatewayMcp(): Promise<void> {
  console.log("\n[2] withBrowser(): injects existing gateway browser-use MCP config");

  const previousGatewayUrl = process.env.EVOLVE_GATEWAY_URL;
  process.env.EVOLVE_GATEWAY_URL = "https://gateway.test";
  try {
    const kit = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(fakeSandboxProvider)
      .withBrowser();

    const mcpServers = await getInitializedMcpServers(kit);
    const browserUse = mcpServers["browser-use"];

    assertEqual(browserUse.type, "http", "browser-use transport preserved");
    assertEqual(browserUse.url, "https://gateway.test/browser_use/mcp", "browser-use gateway URL preserved");
    assertEqual(
      browserUse.headers["x-litellm-api-key"],
      "Bearer evolve-key",
      "browser-use auth header preserved"
    );
  } finally {
    if (previousGatewayUrl === undefined) {
      delete process.env.EVOLVE_GATEWAY_URL;
    } else {
      process.env.EVOLVE_GATEWAY_URL = previousGatewayUrl;
    }
  }
}

async function testUserMcpOverridesBrowserUse(): Promise<void> {
  console.log("\n[3] withBrowser(): user MCP config still overrides browser-use");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser()
    .withMcpServers({
      "browser-use": {
        type: "http",
        url: "https://custom.example/mcp",
      },
    });

  const mcpServers = await getInitializedMcpServers(kit);
  assertEqual(mcpServers["browser-use"].url, "https://custom.example/mcp", "user browser-use MCP override preserved");
}

async function testBrowserUseRequiresGatewayMode(): Promise<void> {
  console.log("\n[4] withBrowser(): direct mode rejects gateway browser-use");

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser();

  try {
    await getInitializedMcpServers(kit);
    assert(false, "direct mode with browser-use should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("requires gateway mode"),
      "direct mode error explains gateway requirement"
    );
  }
}

async function testActionbookBrowserAddsConfig(): Promise<void> {
  console.log("\n[5] withBrowser(\"actionbook\"): stores managed-browser config");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser("actionbook", { superStealth: true });

  const options = await getInitializedAgentOptions(kit);
  assertEqual(options.browser.provider, "actionbook", "actionbook provider stored");
  assertEqual(options.browser.options.superStealth, true, "superStealth option stored");
  assert(!options.mcpServers["browser-use"], "actionbook does not inject browser-use MCP");
  assertEqual(options.skills[0].package, "actionbook/actionbook", "actionbook skills installed through withSkills path");
  assert(
    options.skills[0].skills.includes("active-research"),
    "actionbook package exposes all published skills"
  );
}

async function testActionbookRequiresGatewayMode(): Promise<void> {
  console.log("\n[6] withBrowser(\"actionbook\"): direct mode rejects managed browser setup");

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser("actionbook", { superStealth: true });

  try {
    await getInitializedAgentOptions(kit);
    assert(false, "direct mode with actionbook should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("requires gateway mode"),
      "direct mode error explains gateway requirement"
    );
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Browser Config Tests");
  console.log("=".repeat(70));

  await testBrowserUseNotInjectedByDefault();
  await testWithBrowserInjectsGatewayMcp();
  await testUserMcpOverridesBrowserUse();
  await testBrowserUseRequiresGatewayMode();
  await testActionbookBrowserAddsConfig();
  await testActionbookRequiresGatewayMode();

  console.log("\n" + "=".repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Test runner error:", error);
  process.exit(1);
});
