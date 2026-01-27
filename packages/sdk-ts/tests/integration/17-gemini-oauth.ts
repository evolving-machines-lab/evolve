#!/usr/bin/env tsx
/**
 * Integration Test: Gemini OAuth File Mode
 *
 * Tests that Gemini agent works with OAuth file authentication
 * using the local ~/.gemini/oauth_creds.json file.
 *
 * Prerequisites:
 *   - ~/.gemini/oauth_creds.json exists (run `gemini` and auth first)
 *   - EVOLVE_API_KEY env var set (for sandbox access via gateway)
 *
 * Usage:
 *   EVOLVE_API_KEY=xxx npx tsx tests/integration/17-gemini-oauth.ts
 */

import { Evolve, resolveDefaultSandbox } from "../../dist/index.js";

async function main() {
  console.log("=== Gemini OAuth File Integration Test ===\n");

  if (!process.env.EVOLVE_API_KEY && !process.env.E2B_API_KEY) {
    console.error("Error: Set EVOLVE_API_KEY or E2B_API_KEY env var");
    process.exit(1);
  }

  console.log("Creating Evolve instance with Gemini OAuth file...");

  // Use resolveDefaultSandbox to properly route through gateway when using EVOLVE_API_KEY
  const sandboxProvider = await resolveDefaultSandbox();

  const evolve = new Evolve()
    .withAgent({
      type: "gemini",
      oauthFile: "~/.gemini/oauth_creds.json",
      model: "gemini-3-pro-preview",  // Latest Gemini model
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
      console.log("\n✓ Gemini OAuth file test PASSED");
    } else {
      console.log("\n✗ Gemini OAuth file test FAILED (non-zero exit code)");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n✗ Gemini OAuth file test FAILED:", error);
    process.exit(1);
  } finally {
    await evolve.kill();
  }
}

main();
