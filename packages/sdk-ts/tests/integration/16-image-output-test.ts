#!/usr/bin/env tsx
/**
 * Integration Test 16: Image Output Test
 *
 * Tests image handling in tool results across all 4 agents.
 * Runs 3 prompts sequentially per agent, all agents in parallel.
 *
 * Usage:
 *   npx tsx tests/integration/16-image-output-test.ts
 *   npx tsx tests/integration/16-image-output-test.ts claude
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import type { AgentType, OutputEvent } from "../../dist/index.js";
import { getAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const env = getTestEnv();
const LOGS_DIR = resolve(__dirname, "../test-logs/16-image-output-test");
const FIXTURES_DIR = resolve(__dirname, "../fixtures");

const ALL_AGENTS: AgentType[] = ["claude", "codex", "gemini", "qwen"];

const PROMPTS = [
  {
    name: "browser-screenshot",
    prompt: "Use the dev-browser skill to go to https://example.com and take a screenshot. Be quick.",
  },
  {
    name: "read-image",
    prompt: "Read the image file context/test_image.png and describe what you see in 1 sentence. Be quick.",
  },
  {
    name: "mcp-screenshot",
    prompt: "Use the browser-use MCP server to navigate to https://news.ycombinator.com and take a screenshot of the front page. Be quick.",
  },
];

const mcpServers = {
  "browser-use": {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      "https://api.browser-use.com/mcp",
      "--header",
      `X-Browser-Use-API-Key: ${process.env.BROWSER_USE_API_KEY || ""}`,
    ],
  },
};

function save(agent: string, name: string, content: string) {
  const dir = resolve(LOGS_DIR, agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), content);
}

async function testAgent(type: AgentType): Promise<{ ok: boolean; error?: string; duration: number }> {
  const start = Date.now();

  const evolve = new Evolve()
    .withAgent(getAgentConfig(type))
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }))
    .withContext({ "test_image.png": readFileSync(resolve(FIXTURES_DIR, "test_image.png")) })
    .withSkills(["dev-browser"])
    .withMcpServers(mcpServers)
    .withComposio("test-image-output", { toolkits: ["gmail"] });

  const allEvents: OutputEvent[] = [];
  const rawLines: string[] = [];

  evolve.on("content", (event: OutputEvent) => allEvents.push(event));
  evolve.on("stdout", (line: string) => rawLines.push(line));

  try {
    for (const { name, prompt } of PROMPTS) {
      console.log(`[${type}] ${name}...`);

      const result = await evolve.run({ prompt, timeoutMs: 600000 });

      save(type, `${name}-stdout.txt`, result.stdout);
      save(type, `${name}-raw.jsonl`, rawLines.join(""));

      console.log(`[${type}] ${name} done (exit=${result.exitCode})`);
    }

    save(type, "all-content-events.jsonl", allEvents.map(e => JSON.stringify(e)).join("\n"));
    save(type, "all-raw-output.jsonl", rawLines.join(""));

    await evolve.kill();
    return { ok: true, duration: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    save(type, "error.txt", msg);
    await evolve.kill().catch(() => {});
    return { ok: false, error: msg, duration: Date.now() - start };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const agents = args.length > 0 ? (args as AgentType[]) : ALL_AGENTS;

  // Only clear logs when running all agents
  if (agents.length === ALL_AGENTS.length) {
    rmSync(LOGS_DIR, { recursive: true, force: true });
  }
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log(`Testing image output: ${agents.join(", ")}\n`);

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
  console.log(`${passed}/${agents.length} passed`);
  console.log(`\nLogs saved to: ${LOGS_DIR}\n`);

  process.exit(passed === agents.length ? 0 : 1);
}

main();
