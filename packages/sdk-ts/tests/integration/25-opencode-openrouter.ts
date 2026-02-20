#!/usr/bin/env tsx
/**
 * Integration Test 25: OpenCode via OpenRouter — Gateway + BYOK
 *
 * Tests 4 combinations:
 *   1. Sonnet 4.6 via gateway  (apiKey → LiteLLM → OpenRouter)
 *   2. Sonnet 4.6 via BYOK     (providerApiKey → OpenRouter direct)
 *   3. GPT 5.2 via gateway
 *   4. GPT 5.2 via BYOK
 *
 * Usage:
 *   npx tsx tests/integration/25-opencode-openrouter.ts
 */

import { Evolve } from "../../dist/index.js";
import type { OutputEvent, LifecycleEvent } from "../../dist/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getSandboxProvider } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/25-opencode-openrouter");
const TIMEOUT_MS = 5 * 60 * 1000;
const PROMPT = "Respond with exactly the word: hello";

interface TestCase {
  name: string;
  model: string;
  mode: "gateway" | "byok";
}

function log(msg: string): void {
  console.log(`[25] ${msg}`);
}

function save(name: string, content: string): void {
  writeFileSync(resolve(LOGS_DIR, name), content);
}

function redactSecrets(value: string, secrets: string[]): string {
  let out = value;
  for (const s of secrets) {
    if (s) out = out.split(s).join("<redacted>");
  }
  return out;
}

/** Extract text from OutputEvent[] (shape: { update: { content: { type, text } } }) */
function extractText(events: OutputEvent[]): string {
  return events
    .filter(e => e.update?.content?.type === "text")
    .map(e => e.update.content.text || "")
    .join("");
}

async function runTest(
  tc: TestCase,
  sandbox: ReturnType<typeof getSandboxProvider>,
  keys: { gateway: string; byok: string },
): Promise<{ pass: boolean; error?: string }> {
  const logPrefix = tc.name.replace(/\s+/g, "-").toLowerCase();
  log(`Running: ${tc.name} (${tc.mode}, ${tc.model})`);

  // gateway → apiKey (routes through LiteLLM), byok → providerApiKey (direct to OpenRouter)
  const agentConfig = tc.mode === "gateway"
    ? { type: "opencode" as const, apiKey: keys.gateway, model: tc.model }
    : { type: "opencode" as const, providerApiKey: keys.byok, model: tc.model };

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(sandbox);

  const contentEvents: OutputEvent[] = [];
  evolve.on("content", (e: OutputEvent) => contentEvents.push(e));

  const secrets = [keys.gateway, keys.byok];

  try {
    const run = await evolve.run({ prompt: PROMPT, timeoutMs: TIMEOUT_MS });

    save(`${logPrefix}-stdout.txt`, redactSecrets(run.stdout, secrets));
    save(`${logPrefix}-stderr.txt`, redactSecrets(run.stderr, secrets));
    save(`${logPrefix}-result.json`, JSON.stringify({
      sandboxId: run.sandboxId, exitCode: run.exitCode, model: tc.model, mode: tc.mode,
    }, null, 2));
    save(`${logPrefix}-events.jsonl`, contentEvents.map(e => JSON.stringify(e)).join("\n"));

    if (run.exitCode !== 0) {
      const msg = `exitCode=${run.exitCode}`;
      save(`${logPrefix}-error.txt`, msg);
      return { pass: false, error: msg };
    }

    const text = extractText(contentEvents).toLowerCase();
    if (!text.includes("hello")) {
      const msg = `Response missing "hello": ${text.slice(0, 200)}`;
      save(`${logPrefix}-error.txt`, msg);
      return { pass: false, error: msg };
    }

    return { pass: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    save(`${logPrefix}-error.txt`, redactSecrets(msg, secrets));
    return { pass: false, error: msg };
  } finally {
    await evolve.kill().catch(() => {});
  }
}

async function main(): Promise<void> {
  const EVOLVE_API_KEY = process.env.EVOLVE_API_KEY;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

  if (!EVOLVE_API_KEY) throw new Error("EVOLVE_API_KEY required for gateway tests");
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY required for BYOK tests");

  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const sandbox = getSandboxProvider();
  const keys = { gateway: EVOLVE_API_KEY, byok: OPENROUTER_API_KEY };

  const tests: TestCase[] = [
    { name: "Sonnet 4.6 gateway", model: "openrouter/anthropic/claude-sonnet-4.6", mode: "gateway" },
    { name: "Sonnet 4.6 BYOK",    model: "openrouter/anthropic/claude-sonnet-4.6", mode: "byok" },
    { name: "GPT 5.2 gateway",    model: "openrouter/openai/gpt-5.2",             mode: "gateway" },
    { name: "GPT 5.2 BYOK",       model: "openrouter/openai/gpt-5.2",             mode: "byok" },
  ];

  const results: { name: string; pass: boolean; error?: string }[] = [];

  for (const tc of tests) {
    const result = await runTest(tc, sandbox, keys);
    results.push({ name: tc.name, ...result });
    log(`  ${result.pass ? "PASS" : "FAIL"}: ${tc.name}${result.error ? ` — ${result.error}` : ""}`);
  }

  save("summary.json", JSON.stringify(results, null, 2));

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  log(`\nResults: ${passed} passed, ${failed} failed. Logs: ${LOGS_DIR}`);

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
