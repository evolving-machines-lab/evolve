#!/usr/bin/env tsx
/**
 * Integration Test: Codex OAuth File Mode
 *
 * Tests that Codex agent works with OAuth file authentication
 * using the local ~/.codex/auth.json file.
 *
 * Prerequisites:
 *   - ~/.codex/auth.json exists (run `codex login` first)
 *   - EVOLVE_API_KEY env var set (for sandbox access via gateway)
 *
 * Usage:
 *   EVOLVE_API_KEY=xxx npx tsx tests/integration/16-codex-oauth.ts
 */

import { Evolve, resolveDefaultSandbox } from "../../dist/index.js";

async function main() {
  console.log("=== Codex OAuth File Integration Test ===\n");

  if (!process.env.EVOLVE_API_KEY && !process.env.E2B_API_KEY) {
    console.error("Error: Set EVOLVE_API_KEY or E2B_API_KEY env var");
    process.exit(1);
  }

  console.log("Creating Evolve instance with Codex OAuth file...");

  // Use resolveDefaultSandbox to properly route through gateway when using EVOLVE_API_KEY
  const sandboxProvider = await resolveDefaultSandbox();

  const evolve = new Evolve()
    .withAgent({
      type: "codex",
      oauthFile: "~/.codex/auth.json",
      model: "gpt-5.2",  // Default Codex model
    })
    .withSandbox(sandboxProvider)
    .withSystemPrompt("You are a helpful assistant. Keep responses brief.");

  console.log("Running simple prompt...\n");

  try {
    const result = await evolve.run({
      prompt: "What is 2 + 2? Reply with just the number.",
      timeoutMs: 120000,
    });

    console.log("Exit code:", result.exitCode);
    console.log("Stdout:", result.stdout.slice(0, 500));
    if (result.stderr) {
      console.log("Stderr:", result.stderr.slice(0, 500));
    }

    if (result.exitCode === 0) {
      console.log("\n✓ Codex OAuth file test PASSED");
    } else {
      console.log("\n✗ Codex OAuth file test FAILED (non-zero exit code)");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n✗ Codex OAuth file test FAILED:", error);
    process.exit(1);
  } finally {
    await evolve.kill();
  }
}

main();
