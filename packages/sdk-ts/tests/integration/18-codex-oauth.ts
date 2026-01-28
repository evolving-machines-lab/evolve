#!/usr/bin/env tsx
/**
 * Integration Test 18: Codex OAuth Mode
 *
 * Tests file-based OAuth for Codex using CODEX_OAUTH_FILE_PATH.
 *
 * Required env vars (in .env):
 *   CODEX_OAUTH_FILE_PATH - Path to ~/.codex/auth.json
 *   E2B_API_KEY - For E2B sandbox
 *
 * Usage:
 *   npx tsx tests/integration/18-codex-oauth.ts
 */

import { Evolve } from "../../dist/index.js";
import { getSandboxProvider } from "./test-config.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

async function main() {
  const oauthPath = process.env.CODEX_OAUTH_FILE_PATH;
  if (!oauthPath) {
    console.log("CODEX_OAUTH_FILE_PATH not set - skipping");
    process.exit(0);
  }

  console.log("=".repeat(60));
  console.log("Codex OAuth Integration Test");
  console.log("=".repeat(60));
  console.log(`CODEX_OAUTH_FILE_PATH: ${oauthPath}`);

  const evolve = new Evolve()
    .withAgent({ type: "codex" })
    .withSandbox(getSandboxProvider())
    .withSystemPrompt("Be concise. One sentence max.");

  try {
    console.log("\n[codex] Running OAuth test...");
    const result = await evolve.run({
      prompt: "Say hello and confirm you are working.",
      timeoutMs: 120000,
    });

    console.log(`[codex] Exit code: ${result.exitCode}`);
    console.log(`[codex] Stdout:\n${result.stdout}`);

    if (result.exitCode === 0) {
      console.log("\n✓ PASS - Codex OAuth works!");
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
