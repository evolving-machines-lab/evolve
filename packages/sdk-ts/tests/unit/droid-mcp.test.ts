#!/usr/bin/env tsx
/**
 * Unit Test: Droid MCP Config Writer
 *
 * Validates Droid project-level .factory/mcp.json config shape.
 */

import { writeDroidMcpConfig } from "../../src/mcp/json.ts";
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

async function testDroidMcpFormat(): Promise<void> {
  console.log("\n[1] writes Droid project-level MCP config");

  const { sandbox, readJson } = createMockSandbox();
  await writeDroidMcpConfig(sandbox, "/home/user/workspace", {
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
      args: ["-y", "@playwright/mcp@latest"],
      env: { NODE_ENV: "test" },
    },
  });

  const json = readJson("/home/user/workspace/.factory/mcp.json");
  const servers = (json.mcpServers as Record<string, Record<string, unknown>>) || {};

  assert(servers.remote?.type === "http", "remote server uses type=http");
  assert(servers.remote?.url === "https://mcp.example.com/mcp", "remote server preserves URL");
  assert((servers.remote?.headers as Record<string, string>)?.Authorization === "Bearer token", "remote server preserves headers");
  assert(servers.sseRemote?.type === "sse", "SSE server preserves type=sse");
  assert(servers.sseRemote?.url === "https://mcp.example.com/sse", "SSE server preserves URL");
  assert(servers.local?.type === "stdio", "stdio server uses type=stdio");
  assert(servers.local?.command === "npx", "stdio server preserves command");
  assert(Array.isArray(servers.local?.args), "stdio server preserves args");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Droid MCP Writer Unit Tests");
  console.log("=".repeat(60));

  await testDroidMcpFormat();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
