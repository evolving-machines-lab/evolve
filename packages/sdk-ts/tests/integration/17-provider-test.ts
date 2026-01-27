#!/usr/bin/env tsx
/**
 * Integration Test 17: Provider Test
 *
 * Comprehensive test for sandbox providers (e2b, modal, daytona).
 * Tests all SDK features on a single sandbox instance.
 *
 * Usage:
 *   npx tsx tests/integration/17-provider-test.ts e2b
 *   npx tsx tests/integration/17-provider-test.ts modal
 *   npx tsx tests/integration/17-provider-test.ts daytona
 *   npx tsx tests/integration/17-provider-test.ts all
 */

import { Evolve } from "../../dist/index.js";
import type { OutputEvent } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import {
  getAgentConfig,
  getSandboxProviderByName,
  getAvailableProviders,
  type ProviderName,
} from "./test-config.js";
import { createE2BProvider } from "../../../e2b/dist/index.js";
import { createDaytonaProvider } from "../../../daytona/dist/index.js";
import { createModalProvider } from "../../../modal/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/17-provider-test");
const FIXTURES_DIR = resolve(__dirname, "../fixtures");

// =============================================================================
// HELPERS
// =============================================================================

const load = (name: string) => readFileSync(resolve(FIXTURES_DIR, name));

function log(provider: string, msg: string) {
  console.log(`[${provider}] ${msg}`);
}

function save(provider: string, name: string, content: string | Uint8Array) {
  const dir = resolve(LOGS_DIR, provider);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), content);
}

// =============================================================================
// MAIN TEST
// =============================================================================

interface TestResult {
  provider: ProviderName;
  ok: boolean;
  error?: string;
  duration: number;
  checks: Record<string, boolean>;
}

async function testProvider(provider: ProviderName): Promise<TestResult> {
  const start = Date.now();
  const checks: Record<string, boolean> = {};

  log(provider, "=== Starting provider test ===");

  // Streaming counters
  let contentEvents = 0;
  let stdoutChunks = 0;

  // =========================================================================
  // SETUP: Create Evolve instance with files, skills, composio
  // =========================================================================
  log(provider, "Setting up Evolve instance...");

  const evolve = new Evolve()
    .withAgent(getAgentConfig("claude"))
    .withSandbox(getSandboxProviderByName(provider))
    .withSkills(["pdf", "slides-as-code"])
    .withContext({
      "data.xlsx": load("AMPX_Financial_Analysis.xlsx"),
      "image.png": load("hackernews.png"),
      "readme.txt": Buffer.from("Test context file - ABC123"),
    })
    .withFiles({
      "workspace.txt": Buffer.from("Test workspace file - XYZ789"),
    });

  // Add Composio if available
  if (process.env.COMPOSIO_API_KEY) {
    evolve.withComposio(`test-${provider}-${Date.now()}`, { toolkits: ["gmail"] });
    log(provider, "Composio enabled");
  }

  // Setup streaming listeners
  evolve.on("content", (_event: OutputEvent) => contentEvents++);
  evolve.on("stdout", () => stdoutChunks++);

  try {
    // =========================================================================
    // RUN 1: Check skills and MCP servers
    // =========================================================================
    log(provider, "Run 1: Checking skills and MCP servers...");
    const run1 = await evolve.run({
      prompt: "List your skills and MCP servers. Be brief.",
      timeoutMs: 180000,
    });
    checks["run1_skills_mcp"] = run1.exitCode === 0;
    save(provider, "run1.txt", run1.stdout);
    log(provider, `Run 1: exit=${run1.exitCode}`);

    // =========================================================================
    // RUN 2: Check initial file uploads (withContext, withFiles)
    // =========================================================================
    log(provider, "Run 2: Checking initial uploads...");
    const run2 = await evolve.run({
      prompt: "List files: ls context/ && ls *.txt 2>/dev/null || true",
      timeoutMs: 180000,
    });
    checks["run2_initial_files"] = run2.exitCode === 0;
    save(provider, "run2.txt", run2.stdout);
    log(provider, `Run 2: exit=${run2.exitCode}`);

    // =========================================================================
    // RUNTIME UPLOADS: uploadContext + uploadFiles
    // =========================================================================
    log(provider, "Runtime uploads...");
    await evolve.uploadContext({
      "runtime.png": load("test_image.png"),
    });
    await evolve.uploadFiles({
      "runtime.txt": Buffer.from("Runtime uploaded file"),
    });
    checks["runtime_uploads"] = true;
    log(provider, "Runtime uploads done");

    // =========================================================================
    // RUN 3: Verify runtime uploads
    // =========================================================================
    log(provider, "Run 3: Verifying runtime uploads...");
    const run3 = await evolve.run({
      prompt: "List: ls context/runtime.png && ls runtime.txt",
      timeoutMs: 180000,
    });
    checks["run3_runtime_files"] = run3.exitCode === 0;
    save(provider, "run3.txt", run3.stdout);
    log(provider, `Run 3: exit=${run3.exitCode}`);

    // =========================================================================
    // RUN 4: Create output file
    // =========================================================================
    log(provider, "Run 4: Creating output...");
    const run4 = await evolve.run({
      prompt: `Create output/result.json: {"provider":"${provider}","ok":true}`,
      timeoutMs: 180000,
    });
    checks["run4_create_output"] = run4.exitCode === 0;
    save(provider, "run4.txt", run4.stdout);
    log(provider, `Run 4: exit=${run4.exitCode}`);

    // =========================================================================
    // GET OUTPUT FILES
    // =========================================================================
    log(provider, "Getting output files...");
    const output = await evolve.getOutputFiles(true);
    const outputFiles = Object.keys(output.files);
    checks["output_retrieved"] = outputFiles.length > 0;
    checks["result_json_exists"] = "result.json" in output.files;
    log(provider, `Output files: ${outputFiles.join(", ") || "none"}`);

    for (const [name, content] of Object.entries(output.files)) {
      const data = typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer);
      save(provider, `output_${name.replace(/\//g, "_")}`, data);
    }

    // =========================================================================
    // OPERATION TIMEOUT TEST
    // E2B throws on timeout, Modal returns exit=-1
    // =========================================================================
    log(provider, "Testing operation timeout...");
    let timeoutWorked = false;
    try {
      const timeoutResult = await evolve.executeCommand("sleep 30", { timeoutMs: 5000 });
      // Modal doesn't throw - check for exit=-1 (timeout indicator)
      if (timeoutResult.exitCode === -1) {
        timeoutWorked = true;
        log(provider, `Timeout detected (exit=-1)`);
      }
    } catch (err) {
      // E2B throws on timeout
      timeoutWorked = true;
      log(provider, `Timeout error (expected): ${err instanceof Error ? err.message : err}`);
    }
    checks["operation_timeout"] = timeoutWorked;

    // =========================================================================
    // RUN 5: Verify instance survives timeout
    // =========================================================================
    log(provider, "Run 5: Verifying instance survives timeout...");
    const run5 = await evolve.run({
      prompt: "echo 'still alive'",
      timeoutMs: 60000,
    });
    checks["run5_survives_timeout"] = run5.exitCode === 0;
    save(provider, "run5.txt", run5.stdout);
    log(provider, `Run 5: exit=${run5.exitCode}`);

    // =========================================================================
    // STREAMING CHECK
    // =========================================================================
    checks["streaming_content"] = contentEvents > 0;
    checks["streaming_stdout"] = stdoutChunks > 0;
    log(provider, `Streaming: ${contentEvents} content events, ${stdoutChunks} stdout chunks`);

    // =========================================================================
    // KILL
    // =========================================================================
    log(provider, "Killing sandbox...");
    await evolve.kill();
    checks["kill_success"] = true;
    log(provider, "Sandbox killed");

    // =========================================================================
    // SANDBOX TIMEOUT TEST (separate instance with short-lived provider)
    // =========================================================================
    log(provider, "=== Sandbox timeout test ===");

    // Create provider with 15s default timeout (Modal requires minimum 10s)
    let shortTimeoutProvider;
    switch (provider) {
      case "e2b":
        shortTimeoutProvider = createE2BProvider({
          apiKey: process.env.E2B_API_KEY!,
          defaultTimeoutMs: 15000,
        });
        break;
      case "modal":
        shortTimeoutProvider = createModalProvider({ defaultTimeoutMs: 15000 });
        break;
      case "daytona":
        shortTimeoutProvider = createDaytonaProvider({
          apiKey: process.env.DAYTONA_API_KEY!,
          defaultTimeoutMs: 15000,
        });
        break;
    }

    const shortLivedEvolve = new Evolve()
      .withAgent(getAgentConfig("claude"))
      .withSandbox(shortTimeoutProvider!);

    // Initialize sandbox
    log(provider, "Creating short-lived sandbox (15s timeout)...");
    const initResult = await shortLivedEvolve.executeCommand("echo 'sandbox alive'", {
      timeoutMs: 10000,
    });
    checks["sandbox_timeout_init"] = initResult.exitCode === 0;
    log(provider, `Short-lived sandbox created: exit=${initResult.exitCode}`);

    // Wait for sandbox to expire
    log(provider, "Waiting 20s for sandbox to expire...");
    await new Promise(r => setTimeout(r, 20000));

    // Try to use expired sandbox
    let sandboxExpired = false;
    try {
      await shortLivedEvolve.executeCommand("echo 'should fail'", { timeoutMs: 5000 });
    } catch (err) {
      sandboxExpired = true;
      log(provider, `Sandbox expired (expected): ${err instanceof Error ? err.message : err}`);
    }
    checks["sandbox_timeout_expired"] = sandboxExpired;

    // Cleanup
    await shortLivedEvolve.kill().catch(() => {});

    // =========================================================================
    // RESULT
    // =========================================================================
    const allPassed = Object.values(checks).every(v => v);
    return { provider, ok: allPassed, duration: Date.now() - start, checks };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save(provider, "error.txt", err instanceof Error ? err.stack || msg : msg);
    await evolve.kill().catch(() => {});
    return { provider, ok: false, error: msg, duration: Date.now() - start, checks };
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: npx tsx 17-provider-test.ts <provider>");
    console.log("  Providers: e2b, modal, daytona, all");
    const available = getAvailableProviders();
    console.log(`  Available: ${available.join(", ") || "none"}`);
    process.exit(1);
  }

  let providers: ProviderName[];
  if (args[0] === "all") {
    providers = getAvailableProviders();
    if (providers.length === 0) {
      console.error("No providers available");
      process.exit(1);
    }
  } else {
    providers = args as ProviderName[];
  }

  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log("=".repeat(60));
  console.log("Provider Integration Test");
  console.log(`Providers: ${providers.join(", ")}`);
  console.log(`Composio: ${process.env.COMPOSIO_API_KEY ? "yes" : "no"}`);
  console.log("=".repeat(60) + "\n");

  // Run all providers in parallel
  const results = await Promise.all(providers.map(testProvider));

  // Summary
  console.log("=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  let passed = 0;
  for (const r of results) {
    const status = r.ok ? "PASS" : "FAIL";
    console.log(`\n${status} ${r.provider} (${(r.duration / 1000).toFixed(1)}s)`);
    for (const [check, ok] of Object.entries(r.checks)) {
      console.log(`  ${ok ? "✓" : "✗"} ${check}`);
    }
    if (r.error) console.log(`  Error: ${r.error}`);
    if (r.ok) passed++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} passed`);
  console.log(`Logs: ${LOGS_DIR}`);
  console.log("=".repeat(60));

  process.exit(passed === results.length ? 0 : 1);
}

main();
