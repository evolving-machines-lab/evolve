#!/usr/bin/env tsx
/**
 * Unified Provider Integration Test
 *
 * Tests all SDK features against any sandbox provider:
 * - Sandbox creation & filesystem structure
 * - Skills (pdf, slides-as-code)
 * - Composio integration (Gmail)
 * - MCP servers (browser-use, composio)
 * - Context and file uploads
 * - Output file retrieval
 * - Streaming events
 *
 * Usage:
 *   npx tsx tests/integration/provider-test.ts e2b
 *   npx tsx tests/integration/provider-test.ts modal
 *   npx tsx tests/integration/provider-test.ts daytona
 *   npx tsx tests/integration/provider-test.ts all     # run all available providers
 */

import { Evolve } from "../../dist/index.js";
import type { OutputEvent } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import {
  getAgentConfig,
  getSandboxProviderByName,
  getAvailableProviders,
  type ProviderName,
} from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/provider-test");

// =============================================================================
// HELPERS
// =============================================================================

function log(provider: string, msg: string) {
  console.log(`[${provider}] ${msg}`);
}

function save(provider: string, name: string, content: string | Uint8Array) {
  const dir = resolve(LOGS_DIR, provider);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), content);
}

// =============================================================================
// TEST
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

  log(provider, "Starting test...");

  // Get agent config (defaults to claude)
  const agentConfig = getAgentConfig("claude");

  // Build Evolve instance with full features
  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(getSandboxProviderByName(provider))
    .withSkills(["pdf", "slides-as-code"])
    .withContext({
      "test-context.txt": Buffer.from("Context file for provider test: ABC123"),
    })
    .withFiles({
      "test-file.txt": Buffer.from("Workspace file for provider test: XYZ789"),
    });

  // Add Composio if API key available
  const composioKey = process.env.COMPOSIO_API_KEY;
  if (composioKey) {
    evolve.withComposio(`provider-test-${provider}-${Date.now()}`, {
      toolkits: ["gmail"],
    });
    log(provider, "Composio enabled (Gmail toolkit)");
  } else {
    log(provider, "Composio skipped (COMPOSIO_API_KEY not set)");
  }

  // Collect streaming events
  const contentEvents: OutputEvent[] = [];
  let stdoutChunks = 0;
  let stderrChunks = 0;

  evolve.on("content", (event: OutputEvent) => {
    contentEvents.push(event);
  });
  evolve.on("stdout", () => stdoutChunks++);
  evolve.on("stderr", () => stderrChunks++);

  try {
    // =========================================================================
    // RUN 1: Verify skills and MCP servers
    // =========================================================================
    log(provider, "Run 1: Checking skills and MCP servers...");

    const run1 = await evolve.run({
      prompt: `Please answer these questions:
1. What skills do you have available? List them.
2. What MCP servers are connected? List them.
3. Do you have a browser-use MCP server?
4. Do you have a composio MCP server?

Just list what you see, be brief.`,
      timeoutMs: 300000,
    });

    save(provider, "run1-stdout.txt", run1.stdout);
    save(provider, "run1-stderr.txt", run1.stderr);
    checks["run1_completed"] = run1.exitCode === 0;
    log(provider, `Run 1 done (exit=${run1.exitCode})`);

    // =========================================================================
    // RUN 2: Verify filesystem and create output
    // =========================================================================
    log(provider, "Run 2: Verifying filesystem and creating output...");

    const run2 = await evolve.run({
      prompt: `Execute these steps:
1. Run: pwd
2. Run: ls -la
3. Check if context/test-context.txt exists and show its content
4. Check if test-file.txt exists and show its content
5. Create output/result.json with: {"provider":"${provider}","status":"ok","timestamp":"${new Date().toISOString()}"}
6. Run: ls -la output/

Report results briefly.`,
      timeoutMs: 300000,
    });

    save(provider, "run2-stdout.txt", run2.stdout);
    save(provider, "run2-stderr.txt", run2.stderr);
    checks["run2_completed"] = run2.exitCode === 0;
    log(provider, `Run 2 done (exit=${run2.exitCode})`);

    // =========================================================================
    // Verify output files
    // =========================================================================
    log(provider, "Getting output files...");
    const output = await evolve.getOutputFiles(true);
    const fileNames = Object.keys(output.files);

    checks["output_files_retrieved"] = fileNames.length > 0;
    checks["result_json_created"] = "result.json" in output.files;

    log(provider, `Output files: ${fileNames.join(", ") || "none"}`);

    for (const [name, content] of Object.entries(output.files)) {
      const data = typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer);
      save(provider, `output-${name.replace(/\//g, "_")}`, data);
    }

    // =========================================================================
    // Verify streaming events
    // =========================================================================
    checks["content_events_received"] = contentEvents.length > 0;
    checks["stdout_streaming"] = stdoutChunks > 0;

    log(provider, `Streaming: ${contentEvents.length} content events, ${stdoutChunks} stdout chunks`);
    save(provider, "content-events.jsonl", contentEvents.map(e => JSON.stringify(e)).join("\n"));

    await evolve.kill();

    // =========================================================================
    // Summary
    // =========================================================================
    const allPassed = Object.values(checks).every(v => v);

    return {
      provider,
      ok: allPassed,
      duration: Date.now() - start,
      checks,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save(provider, "error.txt", err instanceof Error ? err.stack || msg : msg);
    await evolve.kill().catch(() => {});

    return {
      provider,
      ok: false,
      error: msg,
      duration: Date.now() - start,
      checks,
    };
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: npx tsx provider-test.ts <provider>");
    console.log("  Providers: e2b, modal, daytona, all");
    console.log("");
    console.log("Available providers (based on env vars):");
    const available = getAvailableProviders();
    for (const p of available) {
      console.log(`  - ${p}`);
    }
    if (available.length === 0) {
      console.log("  (none - set E2B_API_KEY, DAYTONA_API_KEY, or MODAL_TOKEN_ID+MODAL_TOKEN_SECRET)");
    }
    process.exit(1);
  }

  // Determine which providers to test
  let providers: ProviderName[];
  if (args[0] === "all") {
    providers = getAvailableProviders();
    if (providers.length === 0) {
      console.error("No providers available. Set env vars for at least one provider.");
      process.exit(1);
    }
  } else {
    providers = args as ProviderName[];
  }

  // Clean logs
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log("=".repeat(60));
  console.log("Provider Integration Test");
  console.log("=".repeat(60));
  console.log(`Testing: ${providers.join(", ")}`);
  console.log(`Composio: ${process.env.COMPOSIO_API_KEY ? "enabled" : "disabled"}`);
  console.log("");

  // Run tests sequentially (each provider needs its own sandbox)
  const results: TestResult[] = [];
  for (const provider of providers) {
    const result = await testProvider(provider);
    results.push(result);
    console.log("");
  }

  // Summary
  console.log("=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));

  let passed = 0;
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    const duration = (result.duration / 1000).toFixed(1);
    console.log(`\n${status} ${result.provider} (${duration}s)`);

    for (const [check, ok] of Object.entries(result.checks)) {
      console.log(`  ${ok ? "✓" : "✗"} ${check}`);
    }

    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }

    if (result.ok) passed++;
  }

  console.log("\n" + "=".repeat(60));
  console.log(`${passed}/${results.length} providers passed`);
  console.log(`Logs: ${LOGS_DIR}`);
  console.log("=".repeat(60));

  process.exit(passed === results.length ? 0 : 1);
}

main();
