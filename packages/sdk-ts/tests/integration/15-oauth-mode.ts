#!/usr/bin/env tsx
/**
 * Integration Test 15: OAuth Mode (Claude Max Subscription)
 *
 * Tests OAuth direct mode using CLAUDE_CODE_OAUTH_TOKEN.
 * This allows Claude Max subscribers to use their subscription credits.
 *
 * Required env vars (in .env):
 *   CLAUDE_CODE_OAUTH_TOKEN - OAuth token from Claude Max subscription
 *   E2B_API_KEY - For E2B sandbox
 *
 * Usage:
 *   npx tsx tests/integration/15-oauth-mode.ts
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import type { FileMap } from "../../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

const LOGS_DIR = resolve(__dirname, "../test-logs/15-oauth-mode");

function getEnv() {
  return {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    E2B_API_KEY: process.env.E2B_API_KEY,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function save(name: string, content: string | Uint8Array) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function saveOutputFiles(prefix: string, files: FileMap) {
  const dir = resolve(LOGS_DIR, prefix);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer);
    writeFileSync(resolve(dir, name), data);
  }
}

// =============================================================================
// TEST
// =============================================================================

async function testOAuth(): Promise<{ ok: boolean; error?: string; duration: number }> {
  const start = Date.now();
  const env = getEnv();

  // Check required env vars
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { ok: false, error: "CLAUDE_CODE_OAUTH_TOKEN not set", duration: 0 };
  }
  if (!env.E2B_API_KEY) {
    return { ok: false, error: "E2B_API_KEY not set", duration: 0 };
  }

  console.log("[claude] Using OAuth mode (Claude Max subscription)");
  console.log("[claude] Model: sonnet");

  // Build Evolve with explicit oauthToken
  const evolve = new Evolve()
    .withAgent({
      type: "claude",
      oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
      model: "sonnet",
    })
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }))
    .withSystemPrompt("You are a helpful assistant. Be concise.");

  try {
    console.log("[claude] Running OAuth test...");
    const result = await evolve.run({
      prompt: 'Create a file called oauth_test.txt with the content "OAuth mode works!"',
      timeoutMs: 120000,
    });

    save("stdout.txt", result.stdout);
    save("stderr.txt", result.stderr);

    const output = await evolve.getOutputFiles();
    saveOutputFiles("output", output.files);

    console.log(`[claude] Done (exit=${result.exitCode}, outputs=${Object.keys(output.files).length})`);

    // Verify the file was created
    const hasFile = Object.keys(output.files).some(f => f.includes("oauth_test.txt"));
    if (!hasFile) {
      console.log("[claude] Warning: Expected file oauth_test.txt not found in outputs");
    }

    await evolve.kill();
    return { ok: result.exitCode === 0, duration: Date.now() - start };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);
    await evolve.kill().catch(() => {});
    return { ok: false, error: msg, duration: Date.now() - start };
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log("=".repeat(60));
  console.log("OAuth Mode Integration Test (Claude Max Subscription)");
  console.log("=".repeat(60));

  const env = getEnv();
  console.log("\nEnv status:");
  console.log(`  CLAUDE_CODE_OAUTH_TOKEN: ${env.CLAUDE_CODE_OAUTH_TOKEN ? "✓ set" : "✗ not set"}`);
  console.log(`  E2B_API_KEY: ${env.E2B_API_KEY ? "✓ set" : "✗ not set"}`);
  console.log("");

  const { ok, error, duration } = await testOAuth();

  console.log("\n" + "=".repeat(60));
  console.log("Result:");
  console.log("=".repeat(60));

  if (ok) {
    console.log(`✓ PASS claude oauth (${(duration / 1000).toFixed(1)}s)`);
  } else {
    console.log(`✗ FAIL claude oauth - ${error}`);
  }

  console.log("=".repeat(60) + "\n");
  process.exit(ok ? 0 : 1);
}

main();
