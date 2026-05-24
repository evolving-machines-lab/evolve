#!/usr/bin/env tsx
import { Evolve } from "../../dist/index.js";
import { setupIntegrations } from "../../src/integrations";

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

async function testStatusUsesOwnerScopedUserId(): Promise<void> {
  console.log("\n[1] integrations.accounts.list(): sends SDK user ids without extra token");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ accounts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await Evolve.integrations.accounts.list({
      userIds: ["customer_123"],
      app: "gmail",
      statuses: ["ACTIVE"],
      apiKey: "evolve-key",
      dashboardUrl: "https://dashboard.test",
    });

    const call = calls[0];
    assert(
      call.url === "https://dashboard.test/api/integrations/status?userIds=customer_123&app=gmail&statuses=ACTIVE",
      "status URL includes normalized userIds and filters"
    );
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers.Authorization, "Bearer evolve-key", "status forwards Evolve API key");
    assert(headers["x-evolve-integration-user-token"] === undefined, "status does not require an extra app-user secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testSessionSetupForwardsAccountPinning(): Promise<void> {
  console.log("\n[2] withIntegrations(): forwards account pinning and advanced auth options");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ mcp: { url: "https://dashboard.test/mcp", headers: {} } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await setupIntegrations({
      userId: "customer_123",
      apps: ["gmail", "github"],
      accounts: { gmail: ["work"] },
      keys: { github: "github-token" },
      authConfigs: { github: "ac_github" },
      apiKey: "evolve-key",
      dashboardUrl: "https://dashboard.test",
    });

    const call = calls[0];
    assert(call.url === "https://dashboard.test/api/integration-sessions", "setup creates integration session");
    const headers = call.init?.headers as Record<string, string>;
    assertEqual(headers.Authorization, "Bearer evolve-key", "setup forwards Evolve API key");
    const body = JSON.parse(String(call.init?.body));
    assertEqual(body.userId, "customer_123", "setup forwards SDK user id");
    assertEqual(body.apps[0], "gmail", "setup forwards apps");
    assertEqual(body.accounts.gmail[0], "work", "setup forwards account alias");
    assertEqual(body.keys.github, "github-token", "setup forwards API-key auth");
    assertEqual(body.authConfigs.github, "ac_github", "setup forwards custom auth config");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("Managed Integrations Config Tests");
  console.log("======================================================================");

  await testStatusUsesOwnerScopedUserId();
  await testSessionSetupForwardsAccountPinning();

  console.log("\n======================================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("======================================================================");

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
