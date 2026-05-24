#!/usr/bin/env tsx
import { Evolve } from "../../dist/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failed++;
    console.error(`FAIL: ${message}`);
  } else {
    passed++;
    console.log(`PASS: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

async function testStatusForwardsUserToken(): Promise<void> {
  console.log("\n[1] integrations.status(): forwards non-root user token");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ connections: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await Evolve.integrations.status({
      userId: "customer_123",
      userToken: "user-token",
      apiKey: "evolve-key",
      dashboardUrl: "https://dashboard.test",
    });

    const call = calls[0];
    assert(call.url === "https://dashboard.test/api/integrations/status?userId=customer_123", "status URL includes normalized userId");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers.Authorization, "Bearer evolve-key", "status forwards Evolve API key");
    assertEqual(headers["x-evolve-integration-user-token"], "user-token", "status forwards integration user token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testActivityForwardsUserToken(): Promise<void> {
  console.log("\n[2] integrations.activity(): forwards non-root user token");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ activity: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await Evolve.integrations.activity({
      userId: "customer_123",
      userToken: "user-token",
      apiKey: "evolve-key",
      dashboardUrl: "https://dashboard.test",
    });

    const call = calls[0];
    assert(call.url === "https://dashboard.test/api/integrations/activity?userId=customer_123", "activity URL includes normalized userId");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers.Authorization, "Bearer evolve-key", "activity forwards Evolve API key");
    assertEqual(headers["x-evolve-integration-user-token"], "user-token", "activity forwards integration user token");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("Managed Integrations Config Tests");
  console.log("======================================================================");

  await testStatusForwardsUserToken();
  await testActivityForwardsUserToken();

  console.log("\n======================================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("======================================================================");

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
