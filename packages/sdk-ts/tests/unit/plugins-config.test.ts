#!/usr/bin/env tsx
/**
 * Plugin configuration tests
 *
 * Run with:
 *   npx tsx tests/unit/plugins-config.test.ts
 */

import { Evolve, type SandboxCommandHandle, type SandboxInstance, type SandboxProvider } from "../../dist/index.js";

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

function assertIncludes(value: string | undefined, expected: string, message: string): void {
  assert(!!value && value.includes(expected), `${message} (expected ${expected}, got ${value ?? "undefined"})`);
}

function createRecordingProvider(): { provider: SandboxProvider; commands: string[] } {
  const commands: string[] = [];

  const handle: SandboxCommandHandle = {
    processId: "proc-test",
    async wait() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async kill() {
      return true;
    },
  };

  const sandbox: SandboxInstance = {
    sandboxId: "sb-test",
    commands: {
      async run(command: string) {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async spawn(command: string) {
        commands.push(command);
        return handle;
      },
      async list() {
        return [];
      },
      async kill() {
        return true;
      },
    },
    files: {
      async read() {
        return "";
      },
      async write() {},
      async writeBatch() {},
      async makeDir() {},
    },
    async getHost(port: number) {
      return `https://example.test/${port}`;
    },
    async kill() {},
    async pause() {},
  };

  return {
    commands,
    provider: {
      providerType: "mock",
      name: "Mock Sandbox",
      async create() {
        return sandbox;
      },
      async connect() {
        return sandbox;
      },
    },
  };
}

async function runWithProvider(kit: Evolve, provider: SandboxProvider): Promise<void> {
  await kit.withSandbox(provider).executeCommand("echo ok");
}

async function testDroidPluginInstallCommands(): Promise<void> {
  console.log("\n[1] droid plugins: marketplace + plugin install");

  const { provider, commands } = createRecordingProvider();
  const kit = new Evolve()
    .withAgent({ type: "droid", providerApiKey: "provider-key" })
    .withPlugins({
      marketplace: "https://github.com/Factory-AI/factory-plugins",
      plugin: "droid-control@factory-plugins",
    });

  await runWithProvider(kit, provider);

  assertIncludes(commands[0], "droid plugin marketplace add 'https://github.com/Factory-AI/factory-plugins'", "droid marketplace add command emitted");
  assertIncludes(commands[1], "droid plugin install 'droid-control@factory-plugins' --scope user", "droid plugin install command emitted");
  const workspaceIndex = commands.findIndex((command) => command.startsWith("mkdir -p "));
  assert(workspaceIndex > 1, "plugins install before workspace setup");
}

async function testDefaultAgentUsesClaudeInstaller(): Promise<void> {
  console.log("\n[2] default agent: plugins target claude");

  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "provider-key";
  try {
    const { provider, commands } = createRecordingProvider();
    const kit = new Evolve().withPlugins({
      marketplace: "anthropics/claude-code",
      plugin: "commit-commands@anthropics-claude-code",
    });

    await runWithProvider(kit, provider);

    assertIncludes(commands[0], "claude plugin marketplace add 'anthropics/claude-code' --scope user", "default agent uses claude marketplace command");
    assertIncludes(commands[1], "claude plugin install 'commit-commands@anthropics-claude-code' --scope user", "default agent uses claude plugin install command");
  } finally {
    if (previousKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
  }
}

async function testGeminiExtensionCommand(): Promise<void> {
  console.log("\n[3] gemini plugins: extension install");

  const { provider, commands } = createRecordingProvider();
  const kit = new Evolve()
    .withAgent({ type: "gemini", providerApiKey: "provider-key" })
    .withPlugins({
      source: "https://github.com/org/gemini-extension",
      ref: "main",
      autoUpdate: true,
      preRelease: true,
      skipSettings: true,
    });

  await runWithProvider(kit, provider);

  assertIncludes(commands[0], "gemini extensions install 'https://github.com/org/gemini-extension'", "gemini extension install command emitted");
  assertIncludes(commands[0], "--ref 'main'", "gemini ref flag emitted");
  assertIncludes(commands[0], "--auto-update", "gemini auto-update flag emitted");
  assertIncludes(commands[0], "--pre-release", "gemini pre-release flag emitted");
  assertIncludes(commands[0], "--consent", "gemini consent flag emitted");
  assertIncludes(commands[0], "--skip-settings", "gemini skip-settings flag emitted");
}

async function testCodexMarketplaceCommand(): Promise<void> {
  console.log("\n[4] codex plugins: marketplace registration only");

  const { provider, commands } = createRecordingProvider();
  const kit = new Evolve()
    .withAgent({ type: "codex", providerApiKey: "provider-key" })
    .withPlugins({
      marketplace: "https://github.com/org/codex-plugins.git",
      ref: "main",
      sparse: [".agents/plugins", "plugins"],
    });

  await runWithProvider(kit, provider);

  const command = commands.find((item) => item.startsWith("codex plugin marketplace add "));
  assertIncludes(command, "codex plugin marketplace add 'https://github.com/org/codex-plugins.git'", "codex marketplace command emitted");
  assertIncludes(command, "--ref 'main'", "codex ref flag emitted");
  assertIncludes(command, "--sparse '.agents/plugins'", "codex first sparse flag emitted");
  assertIncludes(command, "--sparse 'plugins'", "codex second sparse flag emitted");
}

async function testInvalidShapeFailsForSelectedAgent(): Promise<void> {
  console.log("\n[5] validation: selected agent controls required plugin shape");

  const { provider } = createRecordingProvider();
  const kit = new Evolve()
    .withAgent({ type: "droid", providerApiKey: "provider-key" })
    .withPlugins({ source: "https://github.com/org/gemini-extension" });

  try {
    await runWithProvider(kit, provider);
    assert(false, "droid with gemini extension shape should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("withPlugins() for droid requires marketplace"),
      "validation error names selected agent and missing field"
    );
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Plugin Config Tests");
  console.log("=".repeat(70));

  await testDroidPluginInstallCommands();
  await testDefaultAgentUsesClaudeInstaller();
  await testGeminiExtensionCommand();
  await testCodexMarketplaceCommand();
  await testInvalidShapeFailsForSelectedAgent();

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
