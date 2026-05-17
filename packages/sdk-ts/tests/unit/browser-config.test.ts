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
  console.log("\n[2] withBrowser(\"browser-use\"): injects existing gateway browser-use MCP config");

  const previousGatewayUrl = process.env.EVOLVE_GATEWAY_URL;
  process.env.EVOLVE_GATEWAY_URL = "https://gateway.test";
  try {
    const kit = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(fakeSandboxProvider)
      .withBrowser("browser-use");

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
  console.log("\n[3] withBrowser(\"browser-use\"): user MCP config still overrides browser-use");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser("browser-use")
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
  console.log("\n[4] withBrowser(\"browser-use\"): direct mode rejects gateway browser-use");

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser("browser-use");

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

async function testActionbookStringAddsSkillsOnly(): Promise<void> {
  console.log("\n[5] withBrowser(\"actionbook\"): adds Actionbook skills without managed transport");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withSkills(["pdf"])
    .withBrowser("actionbook");

  const options = await getInitializedAgentOptions(kit);
  assert(options.skills.includes("pdf"), "existing skill preserved");
  assert(options.skills.includes("actionbook"), "actionbook skill added");
  assert(options.skills.includes("active-research"), "active-research skill added");
  assert(options.skills.includes("extract"), "extract skill added");
  assert(!options.skills.includes("agent-browser"), "agent-browser not bundled with Actionbook");
  assert(!options.managedBrowser, "string actionbook does not create managed browser transport");
  assert(!options.browserPrompt, "string actionbook does not add managed browser prompt");
}

async function testManagedActionbookDefault(): Promise<void> {
  console.log("\n[6] withBrowser(): defaults to managed Actionbook");

  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  try {
    const kit = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(fakeSandboxProvider)
      .withBrowser();

    const options = await getInitializedAgentOptions(kit);
    assert(options.skills.includes("actionbook"), "default browser adds actionbook skill");
    assertEqual(options.managedBrowser.apiKey, "evolve-key", "managed browser uses Evolve API key");
    assertEqual(options.managedBrowser.dashboardUrl, "https://dashboard.test", "managed browser uses dashboard URL");
    assert(options.browserPrompt.includes("Actionbook browser automation"), "managed browser prompt added");
  } finally {
    if (previousDashboardUrl === undefined) {
      delete process.env.EVOLVE_DASHBOARD_URL;
    } else {
      process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
    }
  }
}

async function testManagedActionbookRequiresGatewayMode(): Promise<void> {
  console.log("\n[7] managed Actionbook: direct mode rejected");

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser();

  try {
    await getInitializedAgentOptions(kit);
    assert(false, "direct mode with managed Actionbook should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("requires gateway mode"),
      "direct mode error explains gateway requirement"
    );
  }
}

async function testManagedBrowserEnvUsesProxyOnly(): Promise<void> {
  console.log("\n[8] managed browser env: sandbox sees only Evolve proxy endpoint");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider);
  await (kit as any).initializeAgent();
  const agent = ((kit as any).agent as any);
  agent.managedBrowserSession = {
    id: "browser_123",
    cdpUrl: "wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token",
    liveUrl: "https://dashboard.test/browser-sessions/browser_123/live?token=view-token",
  };
  const envs = agent.buildEnvironmentVariables();
  assertEqual(envs.ACTIONBOOK_BROWSER_MODE, "cloud", "Actionbook cloud mode set");
  assertEqual(
    envs.ACTIONBOOK_BROWSER_CDP_ENDPOINT,
    "wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token",
    "Actionbook receives proxied CDP endpoint"
  );
  assert(!JSON.stringify(envs).toLowerCase().includes("driver"), "sandbox env does not expose provider name");
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Browser Config Tests");
  console.log("=".repeat(70));

  await testBrowserUseNotInjectedByDefault();
  await testWithBrowserInjectsGatewayMcp();
  await testUserMcpOverridesBrowserUse();
  await testBrowserUseRequiresGatewayMode();
  await testActionbookStringAddsSkillsOnly();
  await testManagedActionbookDefault();
  await testManagedActionbookRequiresGatewayMode();
  await testManagedBrowserEnvUsesProxyOnly();

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
