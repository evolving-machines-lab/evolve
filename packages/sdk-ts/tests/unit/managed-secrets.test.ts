#!/usr/bin/env tsx

import {
  Evolve,
  MANAGED_SECRET_BINDING_ENV,
  MANAGED_SECRET_PROXY_URL_ENV,
  MANAGED_SECRET_TOKEN_ENV,
  type SandboxCreateOptions,
  type SandboxInstance,
  type SandboxProvider,
} from "../../dist/index.js";

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

function makeSandbox(id = "sbx_managed_secret"): SandboxInstance {
  return {
    sandboxId: id,
    commands: {
      async run() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async spawn() {
        throw new Error("not used");
      },
      async list() {
        return [];
      },
      async kill() {
        return true;
      },
    },
    files: {
      async read() {
        return "";
      },
      async write() {},
      async writeBatch() {},
      async makeDir() {},
    },
    async getHost(port: number) {
      return `https://host.test/${port}`;
    },
    async kill() {},
    async pause() {},
  };
}

function installFetchMock(calls: Array<{ url: string; init?: RequestInit }> = []): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/api/provider-secrets/runtime-token")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_provider",
          bindingSecret: "evrb_provider",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: "9999-12-31T23:59:59.999Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/api/managed-secrets/runtime-token")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          enabled: true,
          token: "evmsrt_runtime",
          bindingSecret: "evmsrb_binding",
          proxyUrl: "https://dashboard.test/api/managed-secrets/proxy",
          expiresAt: "9999-12-31T23:59:59.999Z",
          envs: { GITHUB_TOKEN: "evms_placeholder" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function getInitializedAgent(kit: Evolve): Promise<any> {
  await (kit as any).initializeAgent();
  return (kit as any).agent;
}

async function testBuilderValidation(): Promise<void> {
  console.log("\n[1] withManagedSecrets(): validates gateway-only/run-scoped use");

  const direct = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withManagedSecrets([{ name: "GITHUB_TOKEN" }]);
  try {
    await getInitializedAgent(direct);
    assert(false, "direct mode should reject managed secrets");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("requires gateway mode"),
      "direct mode error explains gateway requirement",
    );
  }

  const existing = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSession("sbx_existing")
    .withManagedSecrets([{ name: "GITHUB_TOKEN" }]);
  try {
    await getInitializedAgent(existing);
    assert(false, "withSession should reject managed secrets");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("cannot be used with withSession"),
      "withSession error explains run-scoped token",
    );
  }
}

async function testOptionsAndSandboxEnvs(): Promise<void> {
  console.log("\n[2] withManagedSecrets(): creates placeholder envs and not EVOLVE_API_KEY");

  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  installFetchMock(fetchCalls);

  let createOptions: SandboxCreateOptions | undefined;
  const sandboxProvider: SandboxProvider = {
    providerType: "mock",
    name: "Mock Sandbox",
    async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
      createOptions = options;
      return makeSandbox();
    },
    async connect(): Promise<SandboxInstance> {
      throw new Error("not used");
    },
  };

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "sk-evolve-key" })
    .withSandbox(sandboxProvider)
    .withManagedSecrets([{ name: "GITHUB_TOKEN" }]);

  const agent = await getInitializedAgent(kit);
  assertEqual(agent.options.managedSecrets.secrets[0].name, "GITHUB_TOKEN", "agent options keep managed secret selector");

  await agent.getSandbox();

  const envs = createOptions?.envs ?? {};
  assertEqual(envs.GITHUB_TOKEN, "evms_placeholder", "sandbox gets managed secret placeholder");
  assertEqual(envs[MANAGED_SECRET_PROXY_URL_ENV], "https://dashboard.test/api/managed-secrets/proxy", "sandbox gets managed secret proxy URL");
  assertEqual(envs[MANAGED_SECRET_TOKEN_ENV], "evmsrt_runtime", "sandbox gets scoped proxy token");
  assertEqual(envs[MANAGED_SECRET_BINDING_ENV], "evmsrb_binding", "sandbox gets scoped binding token");
  assert(!("EVOLVE_API_KEY" in envs), "sandbox does not receive account Evolve API key");
  assert(!JSON.stringify(envs).includes("sk-evolve-key"), "sandbox envs do not contain raw Evolve API key");
  assert(fetchCalls.some((call) => call.url.endsWith("/api/managed-secrets/runtime-token") && call.init?.method === "PATCH"), "runtime token is bound to sandbox");

  await agent.kill();
  assert(fetchCalls.some((call) => call.url.endsWith("/api/managed-secrets/runtime-token") && call.init?.method === "DELETE"), "runtime token is revoked on kill");
}

async function testReservedSecretsRejected(): Promise<void> {
  console.log("\n[3] withSecrets(): rejects managed secret env collisions");

  installFetchMock();
  const sandboxProvider: SandboxProvider = {
    providerType: "mock",
    name: "Mock Sandbox",
    async create(): Promise<SandboxInstance> {
      return makeSandbox();
    },
    async connect(): Promise<SandboxInstance> {
      throw new Error("not used");
    },
  };

  try {
    const kit = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(sandboxProvider)
      .withManagedSecrets([{ name: "GITHUB_TOKEN" }])
      .withSecrets({ GITHUB_TOKEN: "raw-secret" });
    const agent = await getInitializedAgent(kit);
    await agent.getSandbox();
    assert(false, "raw managed secret env collision should throw before sandbox setup");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("reserved"),
      "collision error explains reserved managed env",
    );
  }
}

async function main(): Promise<void> {
  await testBuilderValidation();
  await testOptionsAndSandboxEnvs();
  await testReservedSecretsRejected();

  console.log(`\nManaged secrets tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
