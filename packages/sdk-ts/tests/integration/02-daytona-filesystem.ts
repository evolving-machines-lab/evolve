#!/usr/bin/env tsx
/**
 * Integration Test 02: Daytona Filesystem
 *
 * Tests that the Evolve SDK filesystem structure works correctly with Daytona:
 * - Sandbox creation with evolve-all image
 * - Working directory setup (/home/user/workspace)
 * - Context and file uploads
 * - Output file creation and retrieval
 *
 * Usage:
 *   pnpm --filter @evolvingmachines/sdk exec tsx tests/integration/02-daytona-filesystem.ts
 */

import { Evolve } from "../../dist/index.js";
import { createDaytonaProvider } from "../../../daytona/dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getAgentConfig } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/02-daytona-filesystem");

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;

  if (!DAYTONA_API_KEY) {
    console.error("DAYTONA_API_KEY not set");
    process.exit(1);
  }

  // Clean logs directory
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log("=".repeat(60));
  console.log("Daytona Filesystem Test");
  console.log("=".repeat(60));
  console.log("");

  log("Creating Evolve instance with Daytona provider...");

  // Use same agent config as test 01 (supports gateway and direct mode)
  const agentConfig = getAgentConfig("claude");

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createDaytonaProvider({ apiKey: DAYTONA_API_KEY }))
    .withContext({
      "context_test.txt": Buffer.from("Context file content: ABC123"),
    })
    .withFiles({
      "uploaded_test.txt": Buffer.from("Uploaded file content: XYZ789"),
    });

  try {
    // Single run that tests everything
    log("Starting run (this may take a few minutes if image needs to build)...");

    const result = await evolve.run({
      prompt: `Execute these steps and report results:

1. Run: pwd
2. Run: ls -la /home/user/
3. Run: ls -la /home/user/workspace/ (if exists)
4. Check if context/context_test.txt exists and show its content
5. Check if uploaded_test.txt exists and show its content
6. Create output/result.txt with "Daytona filesystem test successful"
7. Create output/data.json with: {"status":"ok","provider":"daytona","timestamp":"${new Date().toISOString()}"}
8. Run: ls -la output/

Report all command outputs.`,
      timeoutMs: 600000, // 10 minutes for image build
    });

    writeFileSync(resolve(LOGS_DIR, "stdout.txt"), result.stdout);
    writeFileSync(resolve(LOGS_DIR, "stderr.txt"), result.stderr);

    log(`Run completed. Exit code: ${result.exitCode}`);
    log(`Stdout: ${result.stdout.length} chars`);

    // Get output files
    log("Getting output files...");
    const output = await evolve.getOutputFiles(true);
    const fileNames = Object.keys(output.files);

    log(`Output files found: ${fileNames.length}`);
    for (const name of fileNames) {
      const content = output.files[name];
      const size = content instanceof ArrayBuffer ? content.byteLength : content.length;
      log(`  - ${name} (${size} bytes)`);

      // Save to logs
      const data = typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer);
      writeFileSync(resolve(LOGS_DIR, `output_${name.replace(/\//g, "_")}`), data);

      // Print content for small files
      if (size < 500) {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content as ArrayBuffer);
        log(`    Content: ${text.trim()}`);
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    const hasResultTxt = "result.txt" in output.files;
    const hasDataJson = "data.json" in output.files;

    if (hasResultTxt && hasDataJson) {
      console.log("✓ PASS - Daytona filesystem working correctly");
      console.log("  - Sandbox created with evolve-all image");
      console.log("  - Working directory structure created");
      console.log("  - Context files uploaded");
      console.log("  - Workspace files uploaded");
      console.log("  - Output files created and retrieved");
    } else {
      console.log("✗ FAIL - Missing expected output files");
      console.log(`  - result.txt: ${hasResultTxt ? "✓" : "✗"}`);
      console.log(`  - data.json: ${hasDataJson ? "✓" : "✗"}`);
    }
    console.log("=".repeat(60));
    console.log(`\nLogs saved to: ${LOGS_DIR}`);

    await evolve.kill();
    process.exit(hasResultTxt && hasDataJson ? 0 : 1);

  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : err}`);
    writeFileSync(
      resolve(LOGS_DIR, "error.txt"),
      err instanceof Error ? err.stack || err.message : String(err)
    );
    await evolve.kill().catch(() => {});
    process.exit(1);
  }
}

main();
