#!/usr/bin/env tsx
/**
 * Integration Test 24: Kimi Gateway Hello File
 *
 * Requirements:
 * - Gateway mode (EVOLVE_API_KEY required)
 * - Run Kimi CLI
 * - Ask agent to create output/hello.txt
 * - Download output files via getOutputFiles()
 * - Save all artifacts to test logs folder
 *
 * Usage:
 *   npx tsx tests/integration/24-kimi-gateway-hello.ts
 */

import { Evolve, saveLocalDir } from "../../dist/index.js";
import type { OutputEvent, LifecycleEvent } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getTestEnv, getSandboxProvider, getAgentConfig } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/24-kimi-gateway-hello");
const OUTPUT_DIR = resolve(LOGS_DIR, "downloaded-output");
const TIMEOUT_MS = 5 * 60 * 1000;

const PROMPT = [
  "Create exactly one file at output/hello.txt.",
  "Write exactly this one line in it: Hello from Kimi gateway.",
  "Do not create any other files.",
  "After writing, reply with one short confirmation sentence.",
].join(" ");

function log(msg: string): void {
  console.log(`[24] ${msg}`);
}

function save(name: string, content: string): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function toUtf8(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  return String(value);
}

function redactSecrets(value: string, key?: string): string {
  let out = value;
  if (key) out = out.split(key).join("<redacted-api-key>");
  out = out.replace(/Bearer\s+[^\s"]+/g, "Bearer <redacted>");
  return out;
}

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const start = Date.now();
  save("prompt.txt", `${PROMPT}\n`);

  const env = getTestEnv();
  if (!env.EVOLVE_API_KEY) {
    fail("EVOLVE_API_KEY is required for gateway mode");
  }

  const kimi = getAgentConfig("kimi");
  const evolve = new Evolve()
    .withAgent({
      ...kimi,
      apiKey: env.EVOLVE_API_KEY,
    })
    .withSandbox(getSandboxProvider());

  const contentEvents: OutputEvent[] = [];
  const lifecycleEvents: LifecycleEvent[] = [];
  const stdoutLines: string[] = [];
  const stderrChunks: string[] = [];

  evolve.on("content", (event: OutputEvent) => contentEvents.push(event));
  evolve.on("lifecycle", (event: LifecycleEvent) => lifecycleEvents.push(event));
  evolve.on("stdout", (line: string) => stdoutLines.push(line));
  evolve.on("stderr", (chunk: string) => stderrChunks.push(chunk));

  let success = false;
  let failureMessage: string | undefined;

  try {
    log("Running Kimi gateway prompt...");
    const run = await evolve.run({
      prompt: PROMPT,
      timeoutMs: TIMEOUT_MS,
    });

    save("run-stdout.txt", redactSecrets(run.stdout, env.EVOLVE_API_KEY));
    save("run-stderr.txt", redactSecrets(run.stderr, env.EVOLVE_API_KEY));
    save("run-result.json", JSON.stringify({
      sandboxId: run.sandboxId,
      exitCode: run.exitCode,
      checkpoint: run.checkpoint ?? null,
    }, null, 2));

    const mcpConfig = await evolve.executeCommand("cat /home/user/.kimi/mcp.json", { timeoutMs: 60_000 });
    save("kimi-mcp.json", redactSecrets(mcpConfig.stdout, env.EVOLVE_API_KEY));
    save("kimi-mcp-stderr.txt", redactSecrets(mcpConfig.stderr, env.EVOLVE_API_KEY));

    const output = await evolve.getOutputFiles(true);
    save("output-summary.json", JSON.stringify({
      fileCount: Object.keys(output.files).length,
      fileNames: Object.keys(output.files).sort(),
      hasData: output.data != null,
      error: output.error ?? null,
      rawData: output.rawData ?? null,
    }, null, 2));

    saveLocalDir(OUTPUT_DIR, output.files);

    if (run.exitCode !== 0) {
      fail(`Run failed with exitCode=${run.exitCode}`);
    }

    const helloRaw = output.files["hello.txt"];
    if (!helloRaw) fail("Missing downloaded file: hello.txt");
    const helloText = toUtf8(helloRaw).trim();
    save("hello.txt.content.txt", `${helloText}\n`);

    if (helloText !== "Hello from Kimi gateway.") {
      fail(`Unexpected hello.txt content: ${JSON.stringify(helloText)}`);
    }

    success = true;
  } catch (error) {
    const msg = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    failureMessage = msg;
    save("error.txt", redactSecrets(msg, env.EVOLVE_API_KEY));
  } finally {
    save("content-events.jsonl", contentEvents.map((e) => JSON.stringify(e)).join("\n"));
    save("lifecycle-events.jsonl", lifecycleEvents.map((e) => JSON.stringify(e)).join("\n"));
    save("raw-stdout.jsonl", redactSecrets(stdoutLines.join(""), env.EVOLVE_API_KEY));
    save("raw-stderr.log", redactSecrets(stderrChunks.join(""), env.EVOLVE_API_KEY));
    save("final-status.json", JSON.stringify({
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      success,
      failureMessage: failureMessage ?? null,
    }, null, 2));
    await evolve.kill().catch((e) => {
      save("kill-error.txt", String(e));
    });
  }

  if (!success) {
    log(`FAIL. Logs: ${LOGS_DIR}`);
    process.exit(1);
  }

  log(`PASS. Logs: ${LOGS_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
