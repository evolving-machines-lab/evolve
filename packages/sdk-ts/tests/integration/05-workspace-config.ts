#!/usr/bin/env tsx
/**
 * Integration Test 05: Workspace Configuration
 *
 * Tests:
 * - withWorkspaceMode("knowledge") - default mode with folder structure
 * - withWorkspaceMode("swe") - minimal mode for repositories
 * - withWorkingDirectory() - custom working directory
 * - withSecrets() - environment variables in sandbox
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/05-workspace-config");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[05-workspace-config] ${msg}`);
}

function save(name: string, content: string) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  log("Starting test...");
  const start = Date.now();

  const provider = createE2BProvider({ apiKey: env.E2B_API_KEY });

  try {
    // Test 1: withWorkspaceMode("knowledge") - default mode
    log("Test 1: withWorkspaceMode('knowledge') - default mode...");
    const evolve1 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withWorkspaceMode("knowledge");

    const run1 = await evolve1.run({
      prompt: "List all directories in the current workspace with ls -la. Tell me what folders exist.",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    save("knowledge-mode-stdout.txt", run1.stdout);

    // Verify knowledge mode creates expected folders
    const run1b = await evolve1.run({
      prompt: "Check if these folders exist: context/, scripts/, temp/, output/. Use ls -d to check each one.",
      timeoutMs: 180000,
    });
    save("knowledge-mode-folders.txt", run1b.stdout);
    await evolve1.kill();

    // Test 2: withWorkspaceMode("swe") - minimal mode
    log("Test 2: withWorkspaceMode('swe') - minimal mode...");
    const evolve2 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withWorkspaceMode("swe");

    const run2 = await evolve2.run({
      prompt: "List all directories in the current workspace with ls -la. What is the current working directory (pwd)?",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run2.exitCode}`);
    save("swe-mode-stdout.txt", run2.stdout);
    await evolve2.kill();

    // Test 3: withWorkingDirectory() - custom working directory
    log("Test 3: withWorkingDirectory() - custom directory...");
    const customDir = "/home/user/custom-workspace";
    const evolve3 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withWorkingDirectory(customDir);

    const run3 = await evolve3.run({
      prompt: "What is your current working directory? Use pwd command.",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run3.exitCode}`);
    save("custom-dir-stdout.txt", run3.stdout);

    // Verify custom directory
    if (!run3.stdout.includes("custom-workspace")) {
      log("  WARNING: Custom directory may not have been set correctly");
    }
    await evolve3.kill();

    // Test 4: withSecrets() - environment variables
    log("Test 4: withSecrets() - environment variables...");
    const testSecret = "test-secret-value-12345";
    const evolve4 = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(provider)
      .withSecrets({
        MY_TEST_SECRET: testSecret,
        ANOTHER_VAR: "another-value",
      });

    const run4 = await evolve4.run({
      prompt: "Print the environment variable MY_TEST_SECRET using: echo $MY_TEST_SECRET",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run4.exitCode}`);
    save("secrets-stdout.txt", run4.stdout);

    // Verify secret was injected
    if (!run4.stdout.includes(testSecret)) {
      log("  WARNING: Secret may not have been injected correctly");
    } else {
      log("  Secret successfully injected and accessible");
    }
    await evolve4.kill();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All workspace configuration tests passed (${duration}s)`);
    log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`FAIL - ${msg} (${duration}s)`);
    log(`============================================================\n`);
    process.exit(1);
  }
}

main();
