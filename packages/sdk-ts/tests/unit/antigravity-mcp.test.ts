#!/usr/bin/env tsx
/**
 * Unit Test: Antigravity MCP Config and Settings Writers
 *
 * ~/.gemini/config/mcp_config.json in the shape `agy mcp add` writes
 * (serverUrl for remote servers, command/args/env for stdio), and the CLI's
 * own ~/.gemini/antigravity-cli/settings.json with API-key auth, telemetry
 * off and the run's model slug registered under customModelsConfig.
 */

import { writeAntigravityMcpConfig, writeAntigravitySettings } from "../../src/mcp/json.ts";
import { AGENT_REGISTRY, antigravityEffort, antigravityModelSlug } from "../../src/registry.ts";
import { EvolveConfigError } from "../../src/utils/config.ts";
import { homeFileOwnershipCommand } from "../../src/mcp/home-file.ts";
import type { SandboxInstance, SandboxCommandHandle, SandboxCommandResult, ProcessInfo } from "../../src/types.ts";

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

function createNoopHandle(): SandboxCommandHandle {
  return {
    processId: "p1",
    wait: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    kill: async (): Promise<boolean> => true,
  };
}

function createMockSandbox() {
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const ran: string[] = [];

  const sandbox: SandboxInstance = {
    sandboxId: "sbx-1",
    commands: {
      run: async (command: string): Promise<SandboxCommandResult> => {
        ran.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: async (): Promise<SandboxCommandHandle> => createNoopHandle(),
      list: async (): Promise<ProcessInfo[]> => [],
      kill: async (): Promise<boolean> => true,
    },
    files: {
      read: async (path: string): Promise<string> => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path) as string;
      },
      write: async (path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> => {
        if (typeof content !== "string") {
          throw new Error("Mock sandbox only supports string writes in this test");
        }
        files.set(path, content);
      },
      writeBatch: async (): Promise<void> => {},
      makeDir: async (path: string): Promise<void> => {
        dirs.push(path);
      },
    },
    getHost: async (): Promise<string> => "http://localhost:3000",
    kill: async (): Promise<void> => {},
    pause: async (): Promise<void> => {},
  };

  return {
    sandbox,
    dirs,
    ran,
    files,
    readJson(path: string): Record<string, unknown> {
      const raw = files.get(path);
      if (!raw) throw new Error(`Missing file: ${path}`);
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

async function testMcpFormat(): Promise<void> {
  console.log("\n[1] writes ~/.gemini/config/mcp_config.json in the CLI's own shape");

  const { sandbox, readJson, dirs } = createMockSandbox();
  await writeAntigravityMcpConfig(sandbox, {
    remote: {
      url: "https://mcp.example.com/mcp",
      type: "http",
      headers: { Authorization: "Bearer token" },
    },
    sseRemote: {
      url: "https://mcp.example.com/sse",
      type: "sse",
    },
    local: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything@2026.8.31", "stdio"],
      env: { NODE_ENV: "test" },
    },
  });

  assert(dirs.includes("/home/user/.gemini/config"), "creates the shared Antigravity config dir");
  const json = readJson("/home/user/.gemini/config/mcp_config.json");
  const servers = (json.mcpServers as Record<string, Record<string, unknown>>) || {};

  assert(servers.remote?.serverUrl === "https://mcp.example.com/mcp", "a remote server is named by serverUrl (url/httpUrl are rejected by the CLI)");
  assert(!("url" in (servers.remote ?? {})) && !("type" in (servers.remote ?? {})), "the SDK's url and type keys are folded, never copied");
  assert((servers.remote?.headers as Record<string, string>)?.Authorization === "Bearer token", "remote headers are kept");
  assert(servers.sseRemote?.serverUrl === "https://mcp.example.com/sse" && !("type" in (servers.sseRemote ?? {})), "SSE is a serverUrl too — the CLI has no transport field");
  assert(servers.local?.command === "npx", "stdio server keeps command");
  assert(Array.isArray(servers.local?.args) && (servers.local?.args as string[]).length === 3, "stdio server keeps args");
  assert((servers.local?.env as Record<string, string>)?.NODE_ENV === "test", "stdio server keeps env");
  assert(!("type" in (servers.local ?? {})), "stdio server carries no type key");
}

async function testMcpMerge(): Promise<void> {
  console.log("\n[2] preserves the other keys of an existing mcp_config.json");

  const { sandbox, files, readJson } = createMockSandbox();
  files.set("/home/user/.gemini/config/mcp_config.json", JSON.stringify({ someOtherKey: true, mcpServers: { old: { command: "old" } } }));
  await writeAntigravityMcpConfig(sandbox, { fresh: { command: "fresh" } });
  const json = readJson("/home/user/.gemini/config/mcp_config.json");
  assert(json.someOtherKey === true, "unrelated keys survive");
  const servers = json.mcpServers as Record<string, unknown>;
  assert("fresh" in servers && !("old" in servers), "mcpServers is replaced by the run's set");
}

async function testEmptyAndMalformedExisting(): Promise<void> {
  console.log("\n[2b] the CLI's 0-byte mcp_config.json is no config; a malformed one is refused typed");

  const mcpPath = "/home/user/.gemini/config/mcp_config.json";
  const settingsPath = "/home/user/.gemini/antigravity-cli/settings.json";

  // Live: with no servers written, the CLI itself creates an empty mcp_config.json (config/.migrated);
  // a checkpoint restore then hands it back to the writer.
  for (const empty of ["", "   \n"]) {
    const { sandbox, files, readJson } = createMockSandbox();
    files.set(mcpPath, empty);
    await writeAntigravityMcpConfig(sandbox, { fresh: { command: "fresh" } });
    assert("fresh" in (readJson(mcpPath).mcpServers as Record<string, unknown>), `an empty mcp_config.json (${JSON.stringify(empty)}) reads as no servers and is written over`);
    files.set(settingsPath, empty);
    await writeAntigravitySettings(sandbox, AGENT_REGISTRY.antigravity.antigravitySettings!.settingsPath, "vertex_ai/gemini-3.8-flash");
    assert(readJson(settingsPath).modelProvider === "gemini", `an empty settings.json (${JSON.stringify(empty)}) reads as no settings and is written over`);
  }

  for (const [path, run] of [
    [mcpPath, (sandbox: SandboxInstance) => writeAntigravityMcpConfig(sandbox, { fresh: { command: "fresh" } })],
    [settingsPath, (sandbox: SandboxInstance) => writeAntigravitySettings(sandbox, AGENT_REGISTRY.antigravity.antigravitySettings!.settingsPath, "vertex_ai/gemini-3.8-flash")],
  ] as const) {
    const { sandbox, files } = createMockSandbox();
    files.set(path, "{ not json");
    let thrown: unknown;
    try {
      await run(sandbox);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof EvolveConfigError && thrown.message.includes(path), `malformed ${path.split("/").pop()} → EvolveConfigError naming the path (never a bare SyntaxError)`);
    assert(!files.has(path) || files.get(path) === "{ not json", "the malformed file is left as it was");
  }
}

async function testSettings(): Promise<void> {
  console.log("\n[3] writes ~/.gemini/antigravity-cli/settings.json for a run");

  const { sandbox, readJson, dirs, ran } = createMockSandbox();
  const settingsPath = AGENT_REGISTRY.antigravity.antigravitySettings!.settingsPath;
  await writeAntigravitySettings(sandbox, settingsPath, "vertex_ai/gemini-3.5-flash-lite");

  assert(dirs.includes("/home/user/.gemini/antigravity-cli"), "creates the CLI's settings dir");
  assert(
    ran.length === 1 && ran[0] === homeFileOwnershipCommand("/home/user", "/home/user/.gemini/antigravity-cli/settings.json"),
    "settings.json and its directories are handed to the home's owner after every rewrite",
  );
  const json = readJson("/home/user/.gemini/antigravity-cli/settings.json");
  assert(json.modelProvider === "gemini", "modelProvider gemini: the documented API-key auth path");
  assert(json.telemetryEnabled === false, "telemetryEnabled false: the key the binary keeps (enableTelemetry is dropped on rewrite)");
  assert(json.allowNonWorkspaceAccess === true, "allowNonWorkspaceAccess: tasks may touch paths outside the --add-dir root");
  const custom = (json.customModelsConfig as { customModels: Record<string, { modelName: string }> }).customModels;
  assert(custom["vertex_ai/gemini-3.5-flash-lite"]?.modelName === "vertex_ai/gemini-3.5-flash-lite", "the run's slug is registered under its own name");
  assert(!("enableTelemetry" in json), "the documented-but-dropped enableTelemetry key is not written");
}

async function testSettingsMerge(): Promise<void> {
  console.log("\n[4] merges over the CLI's own rewrite of the file");

  const { sandbox, files, readJson } = createMockSandbox();
  // What agy 1.2.11 leaves after a run: sorted keys, our earlier registration.
  files.set(
    "/home/user/.gemini/antigravity-cli/settings.json",
    JSON.stringify({
      allowNonWorkspaceAccess: true,
      customModelsConfig: { customModels: { "gemini-3.5-flash-lite": { modelName: "gemini-3.5-flash-lite" } } },
      modelProvider: "gemini",
      telemetryEnabled: false,
      toolPermission: "always-proceed",
    }),
  );
  await writeAntigravitySettings(sandbox, "~/.gemini/antigravity-cli/settings.json", "vertex_ai/gemini-3.8-flash");
  const json = readJson("/home/user/.gemini/antigravity-cli/settings.json");
  const custom = (json.customModelsConfig as { customModels: Record<string, unknown> }).customModels;
  assert("gemini-3.5-flash-lite" in custom && "vertex_ai/gemini-3.8-flash" in custom, "earlier registrations are kept beside the new one");
  assert(json.toolPermission === "always-proceed", "the CLI's other keys survive");
}

async function testSettingsHomeDir(): Promise<void> {
  console.log("\n[5] follows the sandbox home");

  const { sandbox, files } = createMockSandbox();
  await writeAntigravitySettings(sandbox, "~/.gemini/antigravity-cli/settings.json", "gemini-3.8-flash", "/root");
  assert(files.has("/root/.gemini/antigravity-cli/settings.json"), "~ expands to the given home (the eval box runs as root)");
}

async function testRegistryHelpers(): Promise<void> {
  console.log("\n[6] the registry's two antigravity helpers");

  assert(antigravityEffort("high") === "high" && antigravityEffort("low") === "low" && antigravityEffort("medium") === "medium" && antigravityEffort("max") === "max", "the CLI's own four words pass verbatim");
  assert(antigravityEffort("xhigh") === "max", "xhigh → max (the CLI's ceiling)");
  assert(antigravityEffort("off") === "low" && antigravityEffort("minimal") === "low" && antigravityEffort("no-thinking") === "low", "off/minimal/no-thinking → low: the CLI cannot disable thinking");
  assert(antigravityEffort("thinking") === "medium", "the binary spelling lands on medium");
  assert(antigravityEffort("bogus") === "bogus", "a word outside Evolve's vocabulary rides verbatim so the CLI refuses it");

  assert(antigravityModelSlug("gemini-3.8-flash", {}) === "gemini-3.8-flash", "direct mode: the bare Google name");
  assert(antigravityModelSlug("vertex_ai/gemini-3.8-flash", {}) === "vertex_ai/gemini-3.8-flash", "gateway mode: the alias table's Vertex spelling, as resolved before the call");
  assert(antigravityModelSlug("gemini-3.8-flash", { isExternalGateway: true }) === "vertex_ai/gemini-3.8-flash", "external gateway: a roster alias becomes its wire id (the Vertex route on the gateway root)");
  assert(antigravityModelSlug("gemini-9.9-custom", { isExternalGateway: true }) === "gemini-9.9-custom", "external gateway: a non-roster name rides verbatim");

  const entry = AGENT_REGISTRY.antigravity;
  const command = entry.buildCommand({ prompt: "say 'hi' $HOME", model: "vertex_ai/gemini-3.5-flash-lite", isResume: false, reasoningEffort: "high", isDirectMode: false });
  assert(command.startsWith("antigravity --prompt 'say '\\''hi'\\'' $HOME' --model 'vertex_ai/gemini-3.5-flash-lite' --effort high"), `the command: raw prompt single-quoted, the slug, the effort (${command})`);
  assert(command.includes("--dangerously-skip-permissions --output-format stream-json --add-dir \"$PWD\" < /dev/null"), "permissions skipped, NDJSON, cwd as workspace, stdin closed");
  assert(!command.includes("--print-timeout") && !command.includes("2>"), "no print timeout (the SDK's clock is the bound) and stderr on its own pipe");
  const resumed = entry.buildCommand({ prompt: "p", model: "gemini-3.8-flash", isResume: true, isDirectMode: true });
  assert(resumed.startsWith("antigravity --continue --prompt 'p' --model 'gemini-3.8-flash'") && !resumed.includes("--effort"), "resume rides --continue; no effort when none is given");
  const external = entry.buildCommand({ prompt: "p", model: "gemini-3.1-pro-preview", isResume: false, isDirectMode: true, isExternalGateway: true, reasoningEffort: "xhigh" });
  assert(external.includes("--model 'vertex_ai/gemini-3.1-pro-preview' --effort max"), "external gateway: the wire id and the mapped effort");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Antigravity MCP + Settings Writer Unit Tests");
  console.log("=".repeat(60));

  await testMcpFormat();
  await testMcpMerge();
  await testEmptyAndMalformedExisting();
  await testSettings();
  await testSettingsMerge();
  await testSettingsHomeDir();
  await testRegistryHelpers();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
