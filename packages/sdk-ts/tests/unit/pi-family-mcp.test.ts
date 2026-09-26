#!/usr/bin/env tsx
/**
 * Unit Test: the pi family's config writers (mcp/json.ts) — pi's mcp.json for
 * the pi-mcp-adapter, Prime Agent's settings.json mcpServers, the models.json
 * route both CLIs take, and the settings stamp.
 */

import {
  PI_MCP_ADAPTER_SETTINGS,
  writeJsonSettingsStamp,
  writeModelsJsonRoute,
  writePiMcpConfig,
  writePrimeAgentMcpConfig,
} from "../../src/mcp/json.ts";
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

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

  const sandbox: SandboxInstance = {
    sandboxId: "sbx-1",
    commands: {
      run: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
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
    seed(path: string, content: string): void {
      files.set(path, content);
    },
    readJson(path: string): Record<string, unknown> {
      const raw = files.get(path);
      if (!raw) throw new Error(`Missing file: ${path}`);
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

async function testPiMcp(): Promise<void> {
  console.log("\n[1] pi: ~/.pi/agent/mcp.json in the adapter's shape, discovery off, the file's other keys kept");
  const { sandbox, dirs, seed, readJson } = createMockSandbox();
  seed("/home/user/.pi/agent/mcp.json", JSON.stringify({ settings: { toolPrefix: "x" }, other: 1 }));
  await writePiMcpConfig(sandbox, {
    remote: { url: "https://mcp.example.com/mcp", type: "http", headers: { Authorization: "Bearer token" } },
    sseRemote: { url: "https://mcp.example.com/sse", type: "sse" },
    local: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@2026.8.31"], env: { NODE_ENV: "test" }, cwd: "/w" },
  });
  const json = readJson("/home/user/.pi/agent/mcp.json");
  const servers = json.mcpServers as Record<string, Record<string, unknown>>;
  assert(dirs.includes("/home/user/.pi/agent"), "the agent dir is created");
  assert(same(servers.remote, { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer token" } }), "a remote server is {url, headers} — the adapter speaks streamable HTTP");
  assert(same(servers.sseRemote, { url: "https://mcp.example.com/sse" }), "an sse server is {url} too (the adapter falls back to SSE itself)");
  assert(same(servers.local, { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything@2026.8.31"], cwd: "/w", env: { NODE_ENV: "test" } }), "a stdio server keeps command, args, cwd and env");
  assert(same(json.settings, { toolPrefix: "x", ...PI_MCP_ADAPTER_SETTINGS }), "the pinned adapter settings win, the file's other settings stay");
  assert(json.other === 1, "unrelated keys survive");
}

async function testPrimeMcp(): Promise<void> {
  console.log("\n[2] Prime Agent: settings.json mcpServers in Prime's typed shape, the rest of the file kept");
  const { sandbox, seed, readJson } = createMockSandbox();
  seed("/home/user/.prime/agent/settings.json", JSON.stringify({ retry: { enabled: true } }));
  await writePrimeAgentMcpConfig(sandbox, {
    remote: { url: "https://mcp.example.com/mcp", type: "http", headers: { "X-Team": "t" }, bearerTokenEnvVar: "MCP_TOKEN" },
    sseRemote: { url: "https://mcp.example.com/sse", type: "sse" },
    local: { command: "/usr/local/bin/node", args: ["server.js", "stdio"], cwd: "/w", envVars: ["HOME", "PATH"] },
  });
  const json = readJson("/home/user/.prime/agent/settings.json");
  const servers = json.mcpServers as Record<string, Record<string, unknown>>;
  assert(same(servers.remote, { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Team": "t" }, bearerTokenEnvVar: "MCP_TOKEN" }), "http: type, url, headers, bearerTokenEnvVar");
  assert(same(servers.sseRemote, { type: "http", url: "https://mcp.example.com/sse" }), "sse: Prime has no sse transport, so it is written as http");
  assert(same(servers.local, { type: "stdio", command: "/usr/local/bin/node", args: ["server.js", "stdio"], cwd: "/w", env: { HOME: { env: "HOME" }, PATH: { env: "PATH" } } }), "stdio: envVars become Prime's tagged env references");
  assert(same(json.retry, { enabled: true }), "the file's other keys survive (the settings stamp lives beside the servers)");

  let refused = "";
  try {
    await writePrimeAgentMcpConfig(sandbox, { literal: { command: "x", env: { SECRET: "v" } } });
  } catch (error) {
    refused = (error as Error).message;
  }
  assert(refused.includes('MCP server "literal"') && refused.includes("envVars"), "a literal env value is refused typed, naming the server and the alternative");
}

async function testModelsJsonRoute(): Promise<void> {
  console.log("\n[3] models.json: the literal base URL, the key by env NAME, the model entry, the headers");
  const { sandbox, seed, readJson } = createMockSandbox();
  seed("/home/user/.pi/agent/models.json", JSON.stringify({ providers: { theirs: { baseUrl: "https://x/v1" } } }));
  await writeModelsJsonRoute(
    sandbox,
    {
      agentDir: "~/.pi/agent",
      providerName: "evolve",
      apiKeyRef: "dollar",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrl: "https://gateway.test/api/model-proxy/pi/v1",
      model: "openrouter/anthropic/claude-opus-5",
      reasoning: true,
      thinkingLevel: "high",
    },
    { "x-litellm-customer-id": "sess", "x-litellm-tags": "run:r1" },
  );
  const pi = readJson("/home/user/.pi/agent/models.json").providers as Record<string, Record<string, unknown>>;
  assert(
    same(pi.evolve, {
      baseUrl: "https://gateway.test/api/model-proxy/pi/v1",
      api: "openai-completions",
      apiKey: "$OPENROUTER_API_KEY",
      models: [{ id: "openrouter/anthropic/claude-opus-5", reasoning: true }],
      headers: { "x-litellm-customer-id": "sess", "x-litellm-tags": "run:r1" },
    }),
    "pi: the literal URL, $VAR key reference, the model with reasoning on, the headers at provider level; high needs no thinkingLevelMap",
  );
  assert(same(pi.theirs, { baseUrl: "https://x/v1" }), "another provider in the file survives");

  await writeModelsJsonRoute(
    sandbox,
    {
      agentDir: "~/.prime/agent",
      providerName: "evolve",
      apiKeyRef: "bare",
      apiKeyEnv: "OPENROUTER_API_KEY",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-opus-5",
      reasoning: true,
      thinkingLevel: "max",
    },
    {},
    "/root",
  );
  const prime = readJson("/root/.prime/agent/models.json").providers as Record<string, Record<string, unknown>>;
  assert(
    same(prime.evolve, {
      baseUrl: "https://openrouter.ai/api/v1",
      api: "openai-completions",
      apiKey: "OPENROUTER_API_KEY",
      models: [{ id: "anthropic/claude-opus-5", reasoning: true, thinkingLevelMap: { max: "max" } }],
    }),
    "Prime: the bare env NAME, the home dir honoured, no headers key when none, max gets its thinkingLevelMap (Harbor pi.py:235-239)",
  );

  await writeModelsJsonRoute(
    sandbox,
    { agentDir: "~/.pi/agent", providerName: "evolve", apiKeyRef: "dollar", apiKeyEnv: "K", baseUrl: "https://g/v1", model: "m", reasoning: false, thinkingLevel: "off" },
    {},
  );
  const off = (readJson("/home/user/.pi/agent/models.json").providers as Record<string, Record<string, unknown>>).evolve;
  assert(same(off.models, [{ id: "m", reasoning: false }]), "thinking off → reasoning false and no map");
}

async function testSettingsStamp(): Promise<void> {
  console.log("\n[4] settings stamp: deep merge, the MCP writer's keys and unrelated keys survive");
  const { sandbox, seed, readJson } = createMockSandbox();
  seed("/home/user/.prime/agent/settings.json", JSON.stringify({ mcpServers: { a: { type: "http", url: "u" } }, retry: { enabled: true, provider: { maxRetryDelayMs: 5000 } } }));
  await writeJsonSettingsStamp(sandbox, "~/.prime/agent/settings.json", { retry: { provider: { waitForUsage: { enabled: false, pauseUntilReset: false } } } });
  const json = readJson("/home/user/.prime/agent/settings.json");
  assert(same(json.mcpServers, { a: { type: "http", url: "u" } }), "mcpServers survive");
  assert(same(json.retry, { enabled: true, provider: { maxRetryDelayMs: 5000, waitForUsage: { enabled: false, pauseUntilReset: false } } }), "nested objects merge key by key");

  const fresh = createMockSandbox();
  await writeJsonSettingsStamp(fresh.sandbox, "~/.pi/agent/settings.json", { cacheWarming: "off", enableInstallTelemetry: false });
  assert(same(fresh.readJson("/home/user/.pi/agent/settings.json"), { cacheWarming: "off", enableInstallTelemetry: false }), "a missing file is created from the stamp alone");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("pi-family Config Writer Unit Tests");
  console.log("=".repeat(60));

  await testPiMcp();
  await testPrimeMcp();
  await testModelsJsonRoute();
  await testSettingsStamp();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
