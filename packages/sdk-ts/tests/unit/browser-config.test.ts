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

async function testBrowserUseRemoteObjectRejected(): Promise<void> {
  console.log("\n[5] withBrowser({ provider: \"browser-use\", remote: true }): rejected");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser({ provider: "browser-use", remote: true } as any);

  try {
    await getInitializedMcpServers(kit);
    assert(false, "browser-use object config should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Unsupported browser configuration"),
      "browser-use remote object is not supported"
    );
  }
}

async function testActionbookStringAddsSkillsOnly(): Promise<void> {
  console.log("\n[6] withBrowser(\"actionbook\"): adds Actionbook skills without managed transport");

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

async function testAgentBrowserStringAddsSkillsOnly(): Promise<void> {
  console.log("\n[7] withBrowser(\"agent-browser\"): adds agent-browser skill without managed transport");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withSkills(["pdf"])
    .withBrowser("agent-browser");

  const options = await getInitializedAgentOptions(kit);
  assert(options.skills.includes("pdf"), "existing skill preserved");
  assert(options.skills.includes("agent-browser"), "agent-browser skill added");
  assert(!options.skills.includes("actionbook"), "actionbook not bundled with agent-browser");
  assert(!options.managedBrowser, "string agent-browser does not create managed browser transport");
  assert(!options.browserPrompt, "string agent-browser does not add managed browser prompt");
}

async function testManagedActionbookDefault(): Promise<void> {
  console.log("\n[8] withBrowser(): defaults to remote managed Actionbook");

  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  try {
    const kit = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(fakeSandboxProvider)
      .withBrowser();

    const options = await getInitializedAgentOptions(kit);
    assert(options.skills.includes("actionbook"), "default browser adds actionbook skill");
    assertEqual(options.managedBrowser.provider, "actionbook", "managed browser tracks actionbook provider");
    assertEqual(options.managedBrowser.transport, "managed-a", "managed browser uses default transport");
    assertEqual(options.managedBrowser.apiKey, "evolve-key", "managed browser uses Evolve API key");
    assertEqual(options.managedBrowser.dashboardUrl, "https://dashboard.test", "managed browser uses dashboard URL");
    assert(options.browserPrompt.includes("Actionbook is preconfigured"), "managed browser prompt added");
  } finally {
    if (previousDashboardUrl === undefined) {
      delete process.env.EVOLVE_DASHBOARD_URL;
    } else {
      process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
    }
  }
}

async function testActionbookObjectRemoteDefaultsFalse(): Promise<void> {
  console.log("\n[9] withBrowser({ provider: \"actionbook\" }): remote defaults false");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser({ provider: "actionbook" });

  const options = await getInitializedAgentOptions(kit);
  assert(options.skills.includes("actionbook"), "actionbook skill added");
  assert(!options.managedBrowser, "object config without remote does not create managed browser transport");
  assert(!options.browserPrompt, "object config without remote does not add managed browser prompt");
}

async function testManagedActionbookRequiresGatewayMode(): Promise<void> {
  console.log("\n[10] remote managed Actionbook: direct mode rejected");

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser();

  try {
    await getInitializedAgentOptions(kit);
    assert(false, "direct mode with remote managed Actionbook should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("requires gateway mode"),
      "direct mode error explains gateway requirement"
    );
  }
}

async function testManagedActionbookConfigUsesProxyOnly(): Promise<void> {
  console.log("\n[11] remote managed Actionbook config: sandbox sees only Evolve proxy endpoint");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser();
  await (kit as any).initializeAgent();
  const agent = ((kit as any).agent as any);
  agent.managedBrowserSession = {
    id: "browser_123",
    cdpUrl: "wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token",
    liveUrl: "https://dashboard.test/browser-sessions/browser_123/live?token=view-token",
  };
  const envs = agent.buildEnvironmentVariables();
  assert(!("ACTIONBOOK_BROWSER_MODE" in envs), "Actionbook mode is not passed through env");
  assert(!("ACTIONBOOK_BROWSER_CDP_ENDPOINT" in envs), "Actionbook CDP endpoint is not passed through env");

  const dirs: string[] = [];
  const writes = new Map<string, string>();
  const sandbox = {
    files: {
      makeDir: async (path: string) => { dirs.push(path); },
      write: async (path: string, data: string) => { writes.set(path, data); },
    },
  };

  await agent.setupManagedBrowser(sandbox);
  const config = writes.get("/home/user/.actionbook/config.toml");
  assert(dirs.includes("/home/user/.actionbook"), "Actionbook config directory created");
  assert(config !== undefined, "Actionbook config written");
  assert(config?.includes('mode = "cloud"'), "Actionbook cloud mode set");
  assert(
    config?.includes('cdp_endpoint = "wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token"') ?? false,
    "Actionbook config receives proxied CDP endpoint"
  );
  assert(!config?.toLowerCase().includes("driver"), "Actionbook config does not expose provider name");
}

async function testManagedTransportOverride(): Promise<void> {
  console.log("\n[12] remote managed browser accepts neutral transport override");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser({ provider: "actionbook", remote: true, transport: "managed-b" });

  const options = await getInitializedAgentOptions(kit);
  assertEqual(options.managedBrowser.transport, "managed-b", "managed browser stores neutral transport override");
}

async function testManagedTransportRejectsInvalidValue(): Promise<void> {
  console.log("\n[13] remote managed browser rejects invalid transport override");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser({ provider: "actionbook", remote: true, transport: "raw-provider" } as any);

  try {
    await getInitializedAgentOptions(kit);
    assert(false, "invalid managed transport should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Unsupported managed browser transport"),
      "invalid transport error explains unsupported transport"
    );
  }
}

async function testManagedAgentBrowserConfigUsesProxyOnly(): Promise<void> {
  console.log("\n[14] managed agent-browser config: sandbox sees only Evolve proxy endpoint");

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(fakeSandboxProvider)
    .withBrowser({ provider: "agent-browser", remote: true });
  await (kit as any).initializeAgent();
  const agent = ((kit as any).agent as any);
  const options = agent.options;
  assert(options.skills.includes("agent-browser"), "managed agent-browser adds agent-browser skill");
  assertEqual(options.managedBrowser.provider, "agent-browser", "managed browser tracks agent-browser provider");
  assertEqual(options.managedBrowser.transport, "managed-a", "managed agent-browser uses default transport");
  assert(
    options.browserPrompt.includes("agent-browser CDP connection is already configured"),
    "managed agent-browser prompt added"
  );
  agent.managedBrowserSession = {
    id: "browser_123",
    cdpUrl: "wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token",
    liveUrl: "https://dashboard.test/browser-sessions/browser_123/live?token=view-token",
  };

  const envs = agent.buildEnvironmentVariables();
  assertEqual(
    envs.AGENT_BROWSER_CONFIG,
    "/home/user/.agent-browser/config.json",
    "agent-browser config path is set"
  );
  assert(!JSON.stringify(envs).includes("proxy-token"), "agent-browser env does not contain CDP token");

  const dirs: string[] = [];
  const writes = new Map<string, string>();
  const sandbox = {
    files: {
      makeDir: async (path: string) => { dirs.push(path); },
      write: async (path: string, data: string) => { writes.set(path, data); },
    },
  };

  await agent.setupManagedBrowser(sandbox);
  const config = writes.get("/home/user/.agent-browser/config.json");
  assert(dirs.includes("/home/user/.agent-browser"), "agent-browser config directory created");
  assert(config !== undefined, "agent-browser config written");
  const parsedConfig = JSON.parse(config!);
  assert(!("session" in parsedConfig), "agent-browser config leaves session default to agent-browser");
  assert(
    config?.includes("wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token") ?? false,
    "agent-browser config receives proxied CDP endpoint"
  );
  assert(!config?.toLowerCase().includes("driver"), "agent-browser config does not expose provider name");
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Browser Config Tests");
  console.log("=".repeat(70));

  await testBrowserUseNotInjectedByDefault();
  await testWithBrowserInjectsGatewayMcp();
  await testUserMcpOverridesBrowserUse();
  await testBrowserUseRequiresGatewayMode();
  await testBrowserUseRemoteObjectRejected();
  await testActionbookStringAddsSkillsOnly();
  await testAgentBrowserStringAddsSkillsOnly();
  await testManagedActionbookDefault();
  await testActionbookObjectRemoteDefaultsFalse();
  await testManagedActionbookRequiresGatewayMode();
  await testManagedActionbookConfigUsesProxyOnly();
  await testManagedTransportOverride();
  await testManagedTransportRejectsInvalidValue();
  await testManagedAgentBrowserConfigUsesProxyOnly();

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
