#!/usr/bin/env tsx
/**
 * Integration Test 01: All Agents Parallel
 *
 * Tests: run(), getOutputFiles(), kill(), streaming events
 * Runs all 4 agents in parallel for comprehensive coverage.
 *
 * Usage:
 *   npx tsx tests/integration/01-all-agents-parallel.ts           # all agents
 *   npx tsx tests/integration/01-all-agents-parallel.ts codex     # single agent
 *   npx tsx tests/integration/01-all-agents-parallel.ts claude qwen  # multiple agents
 */

import { Evolve } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import type { AgentType, FileMap, OutputEvent } from "../../dist/index.js";
import { getAgentConfig, getTestEnv, getSandboxProvider } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

const env = getTestEnv();
const LOGS_DIR = resolve(__dirname, "../test-logs/01-all-agents-parallel");
const FIXTURES_DIR = resolve(__dirname, "../fixtures");

const FILES = {
  withContext: "test_image.png",
  withFiles: "hackernews.png",
  uploadFiles: "AMPX_Financial_Analysis.xlsx",
  uploadContext: "hackernews.png",
};

// MCP servers
const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

mcpServers["search_duckduckgo"] = {
  command: "uvx",
  args: ["duckduckgo-mcp-server"],
};

mcpServers["search_bravesearch"] = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-brave-search"],
  env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY || "" },
};

mcpServers["chrome-devtools"] = {
  command: "npx",
  args: [
    "chrome-devtools-mcp@latest",
    "--headless=true",
    "--isolated=true",
    "--chromeArg=--no-sandbox",
    "--chromeArg=--disable-setuid-sandbox",
    "--chromeArg=--disable-dev-shm-usage",
  ],
};

if (process.env.EXA_API_KEY) {
  mcpServers["exa"] = {
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.exa.ai/mcp"],
    env: { EXA_API_KEY: process.env.EXA_API_KEY },
  };
}

const ALL_AGENTS: AgentType[] = ["claude", "codex", "gemini", "qwen"];

// =============================================================================
// HELPERS
// =============================================================================

const load = (name: string) => readFileSync(resolve(FIXTURES_DIR, name));

function save(agent: string, name: string, content: string | Uint8Array) {
  const dir = resolve(LOGS_DIR, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), content);
}

function saveOutputFiles(agent: string, prefix: string, files: FileMap) {
  const dir = resolve(LOGS_DIR, agent, prefix);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer);
    writeFileSync(resolve(dir, name), data);
  }
}

// =============================================================================
// TEST
// =============================================================================

async function testAgent(type: AgentType): Promise<{ ok: boolean; error?: string; duration: number }> {
  const start = Date.now();

  // Build Evolve instance using documented API
  const evolve = new Evolve()
    .withAgent(getAgentConfig(type))
    .withSandbox(getSandboxProvider())
    .withSystemPrompt("Your name is Manus Evolve, a powerful autonomous AI agent.")
    .withContext({
      [FILES.withContext]: load(FILES.withContext),
      //[`test_dir/${FILES.withContext}`]: load(FILES.withContext),
    })
    .withFiles({
      [FILES.withFiles]: load(FILES.withFiles),
      //[`test_dir/${FILES.withFiles}`]: load(FILES.withFiles),
    })
    .withMcpServers(mcpServers);

  // Collect content events (parsed ACP-style events)
  let contentEvents: OutputEvent[] = [];
  evolve.on("content", (event: OutputEvent) => contentEvents.push(event));

  try {
    // Run 1
    console.log(`[${type}] Run 1...`);
    const run1 = await evolve.run({
      prompt: `Create helloworld.txt with "Hello from ${type}!"`,
      timeoutMs: 300000,
    });
    save(type, "run1-stdout.txt", run1.stdout);
    save(type, "run1-stderr.txt", run1.stderr);

    const output1 = await evolve.getOutputFiles();
    saveOutputFiles(type, "run1-output", output1.files);
    save(type, "run1-content.jsonl", contentEvents.map(e => JSON.stringify(e)).join("\n"));
    console.log(`[${type}] Run 1 done (exit=${run1.exitCode}, outputs=${Object.keys(output1.files).length}, events=${contentEvents.length})`);
    contentEvents = [];

    // Runtime upload (commented out - using .withContext/.withFiles only)
    // console.log(`[${type}] Uploading...`);
    // await evolve.uploadFiles({
    //   [FILES.uploadFiles]: load(FILES.uploadFiles),
    //   [`test_dir/${FILES.uploadFiles}`]: load(FILES.uploadFiles),
    // });
    // await evolve.uploadContext({
    //   [FILES.uploadContext]: load(FILES.uploadContext),
    //   [`test_dir/${FILES.uploadContext}`]: load(FILES.uploadContext),
    // });

    // Run 2
    console.log(`[${type}] Run 2...`);
    const run2 = await evolve.run({
      prompt: "Do you see my first request to you ? Please say yes or no. What file did I ask you to create? Then, 1- Add '1234' to the file. 2- Create dcf_model.xlsx with a simple 5-year DCF using openpyxl.",
      timeoutMs: 300000,
    });
    save(type, "run2-stdout.txt", run2.stdout);
    save(type, "run2-stderr.txt", run2.stderr);

    const output2 = await evolve.getOutputFiles();
    saveOutputFiles(type, "run2-output", output2.files);
    save(type, "run2-content.jsonl", contentEvents.map(e => JSON.stringify(e)).join("\n"));
    console.log(`[${type}] Run 2 done (exit=${run2.exitCode}, outputs=${Object.keys(output2.files).length}, events=${contentEvents.length})`);

    await evolve.kill();
    return { ok: true, duration: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    save(type, "error.txt", err instanceof Error ? err.stack || msg : msg);
    await evolve.kill().catch(() => {});
    return { ok: false, error: msg, duration: Date.now() - start };
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const agents = args.length > 0 ? (args as AgentType[]) : ALL_AGENTS;

  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log(`Testing: ${agents.join(", ")}\n`);

  const results = await Promise.all(agents.map(testAgent));

  console.log("\n" + "=".repeat(60));
  let passed = 0;
  for (let i = 0; i < agents.length; i++) {
    const { ok, error, duration } = results[i];
    const status = ok ? "✓ PASS" : "✗ FAIL";
    console.log(`${status} ${agents[i]} (${(duration / 1000).toFixed(1)}s)${error ? ` - ${error}` : ""}`);
    if (ok) passed++;
  }
  console.log("=".repeat(60));
  console.log(`${passed}/${agents.length} passed\n`);

  process.exit(passed === agents.length ? 0 : 1);
}

main();
