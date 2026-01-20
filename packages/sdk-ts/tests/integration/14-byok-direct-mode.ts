#!/usr/bin/env tsx
/**
 * Integration Test 14: BYOK Direct Mode
 *
 * Tests direct mode (Bring Your Own Key) with provider API keys.
 * Uses providerApiKey instead of apiKey to bypass the Evolve gateway.
 *
 * Required env vars (in .env):
 *   ANTHROPIC_API_KEY - For Claude direct mode
 *   OPENAI_API_KEY - For Codex direct mode
 *   GEMINI_API_KEY - For Gemini direct mode
 *   DASHSCOPE_API_KEY - For Qwen direct mode (Alibaba)
 *   E2B_API_KEY - For E2B sandbox direct mode
 *
 * Usage:
 *   npx tsx tests/integration/14-byok-direct-mode.ts           # all agents
 *   npx tsx tests/integration/14-byok-direct-mode.ts claude    # single agent
 *   npx tsx tests/integration/14-byok-direct-mode.ts claude codex  # multiple agents
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import type { AgentType, FileMap } from "../../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

const LOGS_DIR = resolve(__dirname, "../test-logs/14-byok-direct-mode");

interface ProviderEnv {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
  E2B_API_KEY?: string;
}

function getProviderEnv(): ProviderEnv {
  return {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    E2B_API_KEY: process.env.E2B_API_KEY,
  };
}

interface BYOKAgentConfig {
  type: AgentType;
  providerApiKey: string;
  providerBaseUrl?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * Get BYOK agent config using provider API keys directly.
 * This bypasses the Evolve gateway for direct provider access.
 */
function getBYOKAgentConfig(type: AgentType): BYOKAgentConfig | null {
  const env = getProviderEnv();

  switch (type) {
    case "claude":
      if (!env.ANTHROPIC_API_KEY) return null;
      return {
        type: "claude",
        providerApiKey: env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL || "sonnet",
      };

    case "codex":
      if (!env.OPENAI_API_KEY) return null;
      return {
        type: "codex",
        providerApiKey: env.OPENAI_API_KEY,
        model: process.env.CODEX_MODEL || "gpt-5.2",
        reasoningEffort: (process.env.CODEX_REASONING_EFFORT as "low" | "medium" | "high") || "medium",
      };

    case "gemini":
      if (!env.GEMINI_API_KEY) return null;
      return {
        type: "gemini",
        providerApiKey: env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
      };

    case "qwen":
      // Qwen uses DASHSCOPE_API_KEY but SDK maps it to OPENAI_API_KEY format
      // The providerBaseUrl is auto-resolved from registry (Dashscope endpoint)
      if (!env.DASHSCOPE_API_KEY) return null;
      return {
        type: "qwen",
        providerApiKey: env.DASHSCOPE_API_KEY,
        model: process.env.QWEN_OPENAI_MODEL || "qwen3-coder-plus",
      };

    default:
      return null;
  }
}

const ALL_AGENTS: AgentType[] = ["claude", "codex", "gemini", "qwen"];

// =============================================================================
// HELPERS
// =============================================================================

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

async function testAgent(type: AgentType): Promise<{ ok: boolean; error?: string; skipped?: boolean; duration: number }> {
  const start = Date.now();
  const env = getProviderEnv();

  // Check if E2B key is available
  if (!env.E2B_API_KEY) {
    return { ok: false, error: "E2B_API_KEY not set", skipped: true, duration: 0 };
  }

  // Get BYOK config for this agent
  const agentConfig = getBYOKAgentConfig(type);
  if (!agentConfig) {
    const keyName = type === "claude" ? "ANTHROPIC_API_KEY"
      : type === "codex" ? "OPENAI_API_KEY"
      : type === "gemini" ? "GEMINI_API_KEY"
      : "DASHSCOPE_API_KEY";
    return { ok: false, error: `${keyName} not set`, skipped: true, duration: 0 };
  }

  console.log(`[${type}] Using BYOK direct mode with provider key`);
  console.log(`[${type}] Model: ${agentConfig.model}`);

  // Build Evolve instance with BYOK (providerApiKey instead of apiKey)
  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }))
    .withSystemPrompt("You are a helpful assistant. Be concise.");

  try {
    // Simple test: create a file
    console.log(`[${type}] Running BYOK test...`);
    const result = await evolve.run({
      prompt: `Create a file called byok_test_${type}.txt with the content "BYOK direct mode works for ${type}!"`,
      timeoutMs: 120000,
    });

    save(type, "stdout.txt", result.stdout);
    save(type, "stderr.txt", result.stderr);

    const output = await evolve.getOutputFiles();
    saveOutputFiles(type, "output", output.files);

    console.log(`[${type}] Done (exit=${result.exitCode}, outputs=${Object.keys(output.files).length})`);

    // Verify the file was created
    const expectedFile = `byok_test_${type}.txt`;
    const hasFile = Object.keys(output.files).some(f => f.includes(expectedFile));

    if (!hasFile) {
      console.log(`[${type}] Warning: Expected file ${expectedFile} not found in outputs`);
    }

    await evolve.kill();
    return { ok: result.exitCode === 0, duration: Date.now() - start };
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

  console.log("=".repeat(60));
  console.log("BYOK Direct Mode Integration Test");
  console.log("Using provider API keys (bypassing Evolve gateway)");
  console.log("=".repeat(60));
  console.log(`\nTesting: ${agents.join(", ")}\n`);

  // Check which keys are available
  const env = getProviderEnv();
  console.log("Provider keys status:");
  console.log(`  ANTHROPIC_API_KEY: ${env.ANTHROPIC_API_KEY ? "✓ set" : "✗ not set"}`);
  console.log(`  OPENAI_API_KEY: ${env.OPENAI_API_KEY ? "✓ set" : "✗ not set"}`);
  console.log(`  GEMINI_API_KEY: ${env.GEMINI_API_KEY ? "✓ set" : "✗ not set"}`);
  console.log(`  DASHSCOPE_API_KEY: ${env.DASHSCOPE_API_KEY ? "✓ set" : "✗ not set"}`);
  console.log(`  E2B_API_KEY: ${env.E2B_API_KEY ? "✓ set" : "✗ not set"}`);
  console.log("");

  const results = await Promise.all(agents.map(testAgent));

  console.log("\n" + "=".repeat(60));
  console.log("Results:");
  console.log("=".repeat(60));

  let passed = 0;
  let skipped = 0;
  for (let i = 0; i < agents.length; i++) {
    const { ok, error, skipped: wasSkipped, duration } = results[i];
    if (wasSkipped) {
      console.log(`⊘ SKIP ${agents[i]} - ${error}`);
      skipped++;
    } else if (ok) {
      console.log(`✓ PASS ${agents[i]} (${(duration / 1000).toFixed(1)}s)`);
      passed++;
    } else {
      console.log(`✗ FAIL ${agents[i]} (${(duration / 1000).toFixed(1)}s) - ${error}`);
    }
  }

  console.log("=".repeat(60));
  console.log(`${passed}/${agents.length - skipped} passed, ${skipped} skipped\n`);

  // Exit with success if all non-skipped tests passed
  const failed = agents.length - skipped - passed;
  process.exit(failed > 0 ? 1 : 0);
}

main();
