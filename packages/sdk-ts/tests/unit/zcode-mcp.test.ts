#!/usr/bin/env tsx
/**
 * Unit Test: Z Code config writers
 *
 * The MCP writer (`mcp.servers` in ~/.zcode/cli/config.json — every server
 * typed, the schema is a strict discriminated union) and the per-run
 * provider file (~/.zcode/v2/provider_config.json — the one place the CLI
 * reads model, reasoning level, base URL and key; literal key, mode 0600).
 */

import { writeZcodeMcpConfig, writeZcodeProviderConfig } from "../../src/mcp/json.ts";
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

function createMockSandbox(existing: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(existing));
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
        if (typeof content !== "string") throw new Error("Mock sandbox only supports string writes in this test");
        files.set(path, content);
      },
      writeBatch: async (): Promise<void> => {},
      makeDir: async (): Promise<void> => {},
    },
    getHost: async (): Promise<string> => "http://localhost:3000",
    kill: async (): Promise<void> => {},
    pause: async (): Promise<void> => {},
  };

  return {
    sandbox,
    ran,
    readJson(path: string): Record<string, unknown> {
      const raw = files.get(path);
      if (!raw) throw new Error(`Missing file: ${path}`);
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

async function testMcpFormat(): Promise<void> {
  console.log("\n[1] writes typed stdio / http / sse servers under mcp.servers");

  const { sandbox, readJson } = createMockSandbox();
  await writeZcodeMcpConfig(sandbox, {
    everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@2026.8.31"], env: { HOME: "/home/user" } },
    remote: { url: "https://mcp.example.com/mcp", type: "http", headers: { Authorization: "Bearer token" } },
    stream: { url: "https://mcp.example.com/sse", type: "sse" },
    guessed: { url: "https://mcp.example.com/other" },
  });

  const config = readJson("/home/user/.zcode/cli/config.json");
  const servers = (config.mcp as { servers: Record<string, Record<string, unknown>> }).servers;
  assert(JSON.stringify(servers.everything) === JSON.stringify({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@2026.8.31"], env: { HOME: "/home/user" } }), "stdio: type, command, args, env — nothing else");
  assert(JSON.stringify(servers.remote) === JSON.stringify({ type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer token" } }), "http: type, url, headers");
  assert(JSON.stringify(servers.stream) === JSON.stringify({ type: "sse", url: "https://mcp.example.com/sse" }), "sse keeps its transport");
  assert((servers.guessed as { type: string }).type === "sse", "a bare url defaults to sse, the SDK's rule for every JSON writer");
  assert(Object.values(servers).every((s) => typeof s.type === "string"), "every server carries a type (Z Code drops an untyped one)");
}

async function testMcpPreservesExistingConfig(): Promise<void> {
  console.log("\n[2] preserves the rest of ~/.zcode/cli/config.json and other mcp keys");

  const { sandbox, readJson } = createMockSandbox({
    "/home/user/.zcode/cli/config.json": JSON.stringify({ logging: { level: "info" }, mcp: { servers: { old: { type: "stdio", command: "x" } }, other: true } }),
  });
  await writeZcodeMcpConfig(sandbox, { fresh: { command: "server" } });

  const config = readJson("/home/user/.zcode/cli/config.json");
  assert(JSON.stringify(config.logging) === JSON.stringify({ level: "info" }), "unrelated keys survive");
  const mcp = config.mcp as { servers: Record<string, unknown>; other: boolean };
  assert(mcp.other === true, "other mcp keys survive");
  assert(Object.keys(mcp.servers).join(",") === "fresh", "the servers map is replaced by the run's servers");
}

async function testMcpHomeDir(): Promise<void> {
  console.log("\n[3] honours the sandbox home");
  const { sandbox, readJson } = createMockSandbox();
  await writeZcodeMcpConfig(sandbox, { s: { command: "x" } }, "/root");
  assert(Object.keys(readJson("/root/.zcode/cli/config.json")).includes("mcp"), "written under /root/.zcode/cli");
}

async function testProviderFile(): Promise<void> {
  console.log("\n[4] writes the provider file Z Code reads, then tightens it to 0600");

  const { sandbox, ran, readJson } = createMockSandbox();
  await writeZcodeProviderConfig(sandbox, {
    path: "~/.zcode/v2/provider_config.json",
    providerId: "evolve",
    providerName: "Evolve gateway",
    baseUrl: "https://gateway.example.com/v1",
    apiKey: "evrt_zcode_runtime_token",
    model: "openrouter/z-ai/glm-5.3-flash",
    reasoningLevel: "high",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    headers: { "x-litellm-customer-id": "session-abc", "x-litellm-tags": "run:run-001" },
  });

  const doc = readJson("/home/user/.zcode/v2/provider_config.json") as {
    schemaVersion: number;
    config: {
      providerConfigRules: { providerRules: Array<{ providerId: string; providerName: string; config: Record<string, unknown> }> };
      modelConfigRules: { providerModelRules: Array<{ providerId: string; modelId: string; config: Record<string, unknown> }>; manualProviderModelRules: unknown[] };
      defaultModelSelection: { providerId: string; modelId: string; options: { reasoningLevel: string } };
    };
  };
  assert(doc.schemaVersion === 1, "schemaVersion 1");
  const provider = doc.config.providerConfigRules.providerRules[0];
  assert(provider.providerId === "evolve" && provider.providerName === "Evolve gateway", "the Evolve provider entry");
  const pc = provider.config as { group: string; access: { type: string; apiKey: string }; api: { type: string; baseUrl: string; headers: Record<string, string> }; personalModelIds: string[] };
  assert(pc.group === "standard-personal", "a personal provider");
  assert(pc.access.type === "api-key" && pc.access.apiKey === "evrt_zcode_runtime_token", "the literal key (Z Code expands no ${VAR})");
  assert(pc.api.type === "openai-chat-completions" && pc.api.baseUrl === "https://gateway.example.com/v1", "OpenAI chat completions at the gateway's /v1");
  assert(pc.api.headers["x-litellm-customer-id"] === "session-abc" && pc.api.headers["x-litellm-tags"] === "run:run-001", "the spend headers ride api.headers");
  assert(JSON.stringify(pc.personalModelIds) === JSON.stringify(["openrouter/z-ai/glm-5.3-flash"]), "the one model is the provider's personal model");
  const rule = doc.config.modelConfigRules.providerModelRules[0];
  assert(rule.providerId === "evolve" && rule.modelId === "openrouter/z-ai/glm-5.3-flash", "the model rule names the same model");
  const rc = rule.config as { enabled: boolean; properties: { contextWindow: number; supportsToolCall: boolean }; optionSpecs: { maxOutputTokens: { max: number; map: string }; reasoningLevel: { values: string[]; map: string } } };
  assert(rc.enabled === true && rc.properties.contextWindow === 200000 && rc.properties.supportsToolCall === true, "context window and tool support");
  assert(rc.optionSpecs.maxOutputTokens.max === 32768 && rc.optionSpecs.maxOutputTokens.map === '{"max_tokens": maxOutputTokens}', "max_tokens cap");
  assert(JSON.stringify(rc.optionSpecs.reasoningLevel.values) === JSON.stringify(["disabled", "low", "medium", "high"]), "the four reasoning levels");
  assert(rc.optionSpecs.reasoningLevel.map === 'reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}', "disabled sends no field; a level is reasoning_effort");
  assert(doc.config.defaultModelSelection.modelId === "openrouter/z-ai/glm-5.3-flash" && doc.config.defaultModelSelection.options.reasoningLevel === "high", "the default selection is the run's model at the run's level");
  assert(JSON.stringify(doc.config.modelConfigRules.manualProviderModelRules) === "[]", "no manual rules");
  assert(ran.length === 1 && ran[0] === "chmod 600 '/home/user/.zcode/v2/provider_config.json'", "the file is chmod 600 right after the write");
}

async function testProviderFileWithoutHeaders(): Promise<void> {
  console.log("\n[5] external-gateway / direct shape: no headers key at all, the home honoured");
  const { sandbox, readJson } = createMockSandbox();
  await writeZcodeProviderConfig(sandbox, {
    path: "~/.zcode/v2/provider_config.json",
    providerId: "evolve",
    providerName: "Evolve gateway",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-direct",
    model: "z-ai/glm-5.3",
    reasoningLevel: "disabled",
    contextWindow: 200000,
    maxOutputTokens: 32768,
    headers: {},
  }, "/root");
  const doc = readJson("/root/.zcode/v2/provider_config.json") as { config: { providerConfigRules: { providerRules: Array<{ config: { api: Record<string, unknown> } }> }; defaultModelSelection: { options: { reasoningLevel: string } } } };
  assert(!("headers" in doc.config.providerConfigRules.providerRules[0].config.api), "no headers key when none are given");
  assert(doc.config.defaultModelSelection.options.reasoningLevel === "disabled", "disabled is a valid level");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Z Code Config Writer Unit Tests");
  console.log("=".repeat(60));

  await testMcpFormat();
  await testMcpPreservesExistingConfig();
  await testMcpHomeDir();
  await testProviderFile();
  await testProviderFileWithoutHeaders();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
