#!/usr/bin/env tsx
/**
 * Unit Test: Kimi MCP Config Writer
 *
 * Validates Kimi FastMCP config shape in ~/.kimi/mcp.json:
 * - Remote: uses `transport` (not `type`) when explicit type provided
 * - Remote: omits transport when type is omitted (FastMCP infers from URL)
 * - Stdio: uses `transport: "stdio"`
 */

import { writeKimiMcpConfig } from "../../src/mcp/json.ts";
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
        if (typeof content !== "string") {
          throw new Error("Mock sandbox only supports string writes in this test");
        }
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
    readJson(path: string): Record<string, unknown> {
      const raw = files.get(path);
      if (!raw) throw new Error(`Missing file: ${path}`);
      return JSON.parse(raw) as Record<string, unknown>;
    },
  };
}

async function testExplicitRemoteTransport(): Promise<void> {
  console.log("\n[1] explicit HTTP/SSE types are written as transport");

  const { sandbox, readJson } = createMockSandbox();
  await writeKimiMcpConfig(sandbox, {
    httpServer: {
      url: "https://mcp.context7.com/mcp",
      type: "http",
      headers: { CONTEXT7_API_KEY: "test" },
    },
    sseServer: {
      url: "https://example.com/sse",
      type: "sse",
    },
  });

  const json = readJson("/home/user/.kimi/mcp.json");
  const servers = (json.mcpServers as Record<string, Record<string, unknown>>) || {};

  assert(servers.httpServer?.transport === "http", "HTTP server uses transport=http");
  assert(!("type" in (servers.httpServer || {})), "HTTP server omits type field");
  assert(servers.sseServer?.transport === "sse", "SSE server uses transport=sse");
  assert(!("type" in (servers.sseServer || {})), "SSE server omits type field");
}

async function testInferredRemoteTransport(): Promise<void> {
  console.log("\n[2] URL-only remote server omits transport for FastMCP inference");

  const { sandbox, readJson } = createMockSandbox();
  await writeKimiMcpConfig(sandbox, {
    inferred: {
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    },
  });

  const json = readJson("/home/user/.kimi/mcp.json");
  const server = ((json.mcpServers as Record<string, Record<string, unknown>>) || {}).inferred || {};

  assert(server.url === "https://example.com/mcp", "Preserves URL");
  assert(!("transport" in server), "Omits transport when not explicitly set");
}

async function testStdioTransport(): Promise<void> {
  console.log("\n[3] stdio server includes transport=stdio");

  const { sandbox, readJson } = createMockSandbox();
  await writeKimiMcpConfig(sandbox, {
    localTool: {
      command: "npx",
      args: ["chrome-devtools-mcp@latest"],
      env: { NODE_ENV: "test" },
    },
  });

  const json = readJson("/home/user/.kimi/mcp.json");
  const server = ((json.mcpServers as Record<string, Record<string, unknown>>) || {}).localTool || {};

  assert(server.command === "npx", "Preserves stdio command");
  assert(server.transport === "stdio", "Stdio server uses transport=stdio");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Kimi MCP Writer Unit Tests");
  console.log("=".repeat(60));

  await testExplicitRemoteTransport();
  await testInferredRemoteTransport();
  await testStdioTransport();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
