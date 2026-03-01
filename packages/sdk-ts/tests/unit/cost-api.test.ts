#!/usr/bin/env tsx
/**
 * Unit Test: Cost API
 *
 * Covers:
 * - getSessionCost() payload normalization
 * - getRunCost() by runId and by index
 * - previous session tag fallback (post-kill query path)
 */

import { Agent } from "../../dist/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${message}`);
    return;
  }
  failed++;
  console.log(`  ✗ ${message}`);
  console.log(`      Expected: ${String(expected)}`);
  console.log(`      Actual:   ${String(actual)}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createAgent(): Agent {
  const config = {
    type: "claude",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  return new Agent(config as any, {});
}

async function testSessionCostNormalization(): Promise<void> {
  console.log("\n[1] getSessionCost() normalizes run metadata");
  const agent = createAgent();
  (agent as any).previousSessionTag = "evolve-prev-session";

  const originalFetch = globalThis.fetch;
  let lastUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastUrl = String(input);
    return jsonResponse({
      sessionTag: "evolve-prev-session",
      totalCost: 1.2345,
      totalTokens: { prompt: 100, completion: 50 },
      runs: [
        {
          runId: "run-1",
          index: 1,
          cost: 1.2345,
          tokens: { prompt: 100, completion: 50 },
          model: "claude-opus-4-6",
          requests: 2,
        },
      ],
      asOf: "2026-02-25T00:00:00.000Z",
      isComplete: true,
      truncated: false,
    });
  }) as typeof fetch;

  try {
    const session = await agent.getSessionCost();
    assert(lastUrl.includes("tag=evolve-prev-session"), "uses previous session tag when no active session");
    assertEqual(session.runs[0].asOf, "2026-02-25T00:00:00.000Z", "fills run.asOf from session response");
    assertEqual(session.runs[0].isComplete, true, "fills run.isComplete from session response");
    assertEqual(session.runs[0].truncated, false, "fills run.truncated from session response");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testRunCostSelectors(): Promise<void> {
  console.log("\n[2] getRunCost() supports runId and index selectors");
  const agent = createAgent();
  (agent as any).previousSessionTag = "evolve-prev-session";

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const queue: Response[] = [
    // runId selector response (missing metadata fields on purpose)
    jsonResponse({
      runId: "run-abc",
      index: 1,
      cost: 0.42,
      tokens: { prompt: 10, completion: 5 },
      model: "claude-sonnet-4-5-20250929",
      requests: 1,
    }),
    // index selector -> session response
    jsonResponse({
      sessionTag: "evolve-prev-session",
      totalCost: 1.0,
      totalTokens: { prompt: 30, completion: 10 },
      runs: [
        {
          runId: "run-1",
          index: 1,
          cost: 0.4,
          tokens: { prompt: 10, completion: 4 },
          model: "claude-sonnet-4-5-20250929",
          requests: 1,
        },
        {
          runId: "run-2",
          index: 2,
          cost: 0.6,
          tokens: { prompt: 20, completion: 6 },
          model: "claude-opus-4-6",
          requests: 1,
        },
      ],
      asOf: "2026-02-25T01:00:00.000Z",
      isComplete: false,
      truncated: true,
    }),
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("No queued response");
    return next;
  }) as typeof fetch;

  try {
    const byRunId = await agent.getRunCost({ runId: "run-abc" });
    assert(urls[0].includes("runId=run-abc"), "runId selector sends runId query param");
    assertEqual(byRunId.runId, "run-abc", "returns requested runId payload");
    assertEqual(byRunId.isComplete, false, "runId fallback defaults isComplete when missing");
    assertEqual(byRunId.truncated, false, "runId fallback defaults truncated when missing");

    const byIndex = await agent.getRunCost({ index: -1 });
    assertEqual(byIndex.runId, "run-2", "negative index resolves from end");
    assertEqual(byIndex.asOf, "2026-02-25T01:00:00.000Z", "index selector inherits normalized metadata");
    assertEqual(byIndex.truncated, true, "index selector preserves session truncated flag");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testNoActivitySessionSwitchDoesNotClobberTag(): Promise<void> {
  console.log("\n[3] setSession()/kill() without local activity keeps prior spend tag");
  const agent = createAgent();
  (agent as any).previousSessionTag = "evolve-prev-session";
  (agent as any).sessionTag = "evolve-current-session";

  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return jsonResponse({
      sessionTag: "evolve-prev-session",
      totalCost: 0,
      totalTokens: { prompt: 0, completion: 0 },
      runs: [],
      asOf: "2026-02-25T02:00:00.000Z",
      isComplete: false,
      truncated: false,
    });
  }) as typeof fetch;

  try {
    // No local run() happened on this switched session
    await agent.setSession("sandbox-switched");
    await agent.getSessionCost();

    // Still no local run() before kill()
    await agent.kill();
    await agent.getSessionCost();

    assert(urls[0].includes("tag=evolve-prev-session"), "setSession() without activity keeps prior tag");
    assert(urls[1].includes("tag=evolve-prev-session"), "kill() without activity keeps prior tag");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testCustomHeaderMergeHandlesNewlineFormat(): Promise<void> {
  console.log("\n[4] mergeCustomHeaders() preserves newline-delimited user headers");
  const agent = createAgent() as any;
  agent.sessionTag = "evolve-session";
  agent.options = {
    secrets: {
      ANTHROPIC_CUSTOM_HEADERS: "x-custom-one: foo\nx-custom-two: bar",
    },
  };

  const envs = agent.buildRunEnvs("run-xyz") as Record<string, string> | undefined;
  const headers = envs?.ANTHROPIC_CUSTOM_HEADERS || "";
  const lines = headers.split("\n").map((l: string) => l.trim()).filter(Boolean);

  assert(lines.some((l: string) => l === "x-custom-one: foo"), "keeps first user header as separate line");
  assert(lines.some((l: string) => l === "x-custom-two: bar"), "keeps second user header as separate line");
  assert(lines.some((l: string) => l === "x-litellm-customer-id: evolve-session"), "injects customer-id");
  assert(lines.some((l: string) => l === "x-litellm-tags: run:run-xyz"), "injects run tag");
}

async function testTagAppendBehavior(): Promise<void> {
  console.log("\n[5] mergeCustomHeaders() appends to existing x-litellm-tags");
  const agent = createAgent() as any;
  agent.sessionTag = "evolve-session";
  agent.options = {
    secrets: {
      ANTHROPIC_CUSTOM_HEADERS: "x-litellm-tags: project:acme,env:prod\nx-custom-one: keep-me",
    },
  };

  const envs = agent.buildRunEnvs("run-xyz") as Record<string, string> | undefined;
  const headers = envs?.ANTHROPIC_CUSTOM_HEADERS || "";
  const lines = headers.split("\n").map((l: string) => l.trim()).filter(Boolean);

  const tagLine = lines.find((l: string) => l.startsWith("x-litellm-tags:"));
  assert(!!tagLine, "has x-litellm-tags line");
  assert(tagLine!.includes("project:acme"), "preserves user tag project:acme");
  assert(tagLine!.includes("env:prod"), "preserves user tag env:prod");
  assert(tagLine!.includes("run:run-xyz"), "appends SDK run tag");
  assert(lines.some((l: string) => l === "x-custom-one: keep-me"), "keeps other user headers");
}

async function testCodexSpendTrackingEnvs(): Promise<void> {
  console.log("\n[6] buildRunEnvs() uses spendTrackingEnvs for Codex-style agents");
  const config = {
    type: "codex",
    apiKey: "test-gateway-key",
    isDirectMode: false,
  };
  const agent = new Agent(config as any, {});
  (agent as any).sessionTag = "evolve-codex-session";

  const envs = (agent as any).buildRunEnvs("run-codex-123") as Record<string, string> | undefined;
  assert(!!envs, "returns env overrides");
  assertEqual(envs?.EVOLVE_LITELLM_CUSTOMER_ID, "evolve-codex-session", "session tag env set");
  assertEqual(envs?.EVOLVE_LITELLM_TAGS, "run:run-codex-123", "run tag env set");

  // Verify no ANTHROPIC_CUSTOM_HEADERS (that's Claude-only)
  assert(!envs?.ANTHROPIC_CUSTOM_HEADERS, "no ANTHROPIC_CUSTOM_HEADERS for codex");
}

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Cost API Unit Tests");
  console.log("============================================================");
  await testSessionCostNormalization();
  await testRunCostSelectors();
  await testNoActivitySessionSwitchDoesNotClobberTag();
  await testCustomHeaderMergeHandlesNewlineFormat();
  await testTagAppendBehavior();
  await testCodexSpendTrackingEnvs();
  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
