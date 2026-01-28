#!/usr/bin/env tsx
/**
 * Integration Test 19: Gemini OAuth Mode
 *
 * Tests file-based OAuth for Gemini using GEMINI_OAUTH_FILE_PATH.
 * Gemini requires both the oauth_creds.json file AND GOOGLE_GENAI_USE_GCA=true.
 *
 * Required env vars (in .env):
 *   GEMINI_OAUTH_FILE_PATH - Path to ~/.gemini/oauth_creds.json
 *   E2B_API_KEY - For E2B sandbox
 *
 * Usage:
 *   npx tsx tests/integration/19-gemini-oauth.ts
 */

import { Evolve } from "../../dist/index.js";
import { getSandboxProvider } from "./test-config.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

async function main() {
  const oauthPath = process.env.GEMINI_OAUTH_FILE_PATH;
  if (!oauthPath) {
    console.log("GEMINI_OAUTH_FILE_PATH not set - skipping");
    process.exit(0);
  }

  console.log("=".repeat(60));
  console.log("Gemini OAuth Integration Test");
  console.log("=".repeat(60));
  console.log(`GEMINI_OAUTH_FILE_PATH: ${oauthPath}`);

  const evolve = new Evolve()
    .withAgent({ type: "gemini" })
    .withSandbox(getSandboxProvider())
    .withSystemPrompt("Be concise. One sentence max.");

  try {
    console.log("\n[gemini] Running OAuth test...");
    const result = await evolve.run({
      prompt: "Say hello and confirm you are working.",
      timeoutMs: 120000,
    });

    console.log(`[gemini] Exit code: ${result.exitCode}`);
    console.log(`[gemini] Stdout:\n${result.stdout}`);

    if (result.exitCode === 0) {
      console.log("\n✓ PASS - Gemini OAuth works!");
    } else {
      console.log("\n✗ FAIL - Non-zero exit code");
      console.log("stderr:", result.stderr.slice(0, 500));
    }

    console.log(`\nSandbox ID: ${result.sandboxId}`);
    console.log("(sandbox kept alive)");
    process.exit(result.exitCode === 0 ? 0 : 1);
  } catch (err) {
    console.error("\n✗ FAIL -", err);
    process.exit(1);
  }
}

main();
