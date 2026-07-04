#!/usr/bin/env tsx

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createManagedSecretRuntimeToken as requestManagedSecretRuntimeToken,
  managedSecretCaSetupCommand,
  managedSecretProxyConfig,
  managedSecretProxyConfigCleanupCommand,
  managedSecretProxyStartCommand,
  managedSecretSandboxEnvs,
  MANAGED_SECRET_PROXY_CONFIG_PATH,
  MANAGED_SECRET_PROXY_SCRIPT,
  managedSecrets,
  type ManagedSecretRuntimeToken,
} from "../../src/managed-secrets";
import { resolveManagedSandbox } from "../../src/utils/sandbox";
import type {
  SandboxCommandHandle,
  SandboxCommandResult,
  SandboxCommands,
  SandboxCreateOptions,
  SandboxFiles,
  SandboxInstance,
  SandboxProvider,
  SandboxRunOptions,
  SandboxSpawnOptions,
  ProcessInfo,
} from "../../dist/index.js";
import { Agent, Evolve } from "../../dist/index.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

class MockFiles implements SandboxFiles {
  writes = new Map<string, string>();
  dirs: string[] = [];

  async read(path: string): Promise<string | Uint8Array> {
    const value = this.writes.get(path);
    if (value === undefined) throw new Error("not found");
    return value;
  }

  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    this.writes.set(path, String(content));
  }

  async writeBatch(): Promise<void> {}

  async makeDir(path: string): Promise<void> {
    this.dirs.push(path);
  }
}

class MockCommands implements SandboxCommands {
  spawned: string[] = [];
  runCommands: string[] = [];
  events: string[] = [];
  proxyKilled = false;

  async run(command: string, _options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    this.runCommands.push(command);
    this.events.push(`run:${command}`);
    if (command.includes("evolve-restore.tar.gz") && command.includes("sha256sum")) {
      return { exitCode: 0, stdout: "hash_restore\n", stderr: "" };
    }
    if (command.includes("evolve-ckpt.tar.gz") && command.includes("sha256sum")) {
      return { exitCode: 0, stdout: "a".repeat(64) + "\n", stderr: "" };
    }
    if (command.includes("stat") && command.includes("evolve-ckpt.tar.gz")) {
      return { exitCode: 0, stdout: "10\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    this.spawned.push(command);
    this.events.push(`spawn:${command}`);
    const isProxy = command.includes("evolve-managed-secrets/proxy.py");
    if (!isProxy) {
      setTimeout(() => options?.onStdout?.('{"type":"noop"}\n'), 1);
    }
    return {
      processId: `p-${this.spawned.length}`,
      wait: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      kill: async () => {
        if (isProxy) this.proxyKilled = true;
        return true;
      },
    };
  }

  async list(): Promise<ProcessInfo[]> {
    return [];
  }

  async kill(): Promise<boolean> {
    return true;
  }
}

class MockSandbox implements SandboxInstance {
  readonly sandboxId = "sbx_managed_secret";
  readonly commands = new MockCommands();
  readonly files = new MockFiles();
  killed = false;

  async getHost(port: number): Promise<string> {
    return `https://host.test/${port}`;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  async pause(): Promise<void> {}
}

class MockProvider implements SandboxProvider {
  readonly providerType = "mock";
  readonly name = "Mock";
  sandbox = new MockSandbox();
  createOptions?: SandboxCreateOptions;

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    this.createOptions = options;
    return this.sandbox;
  }

  async connect(): Promise<SandboxInstance> {
    return this.sandbox;
  }
}

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function installFetchMock(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = String(url);
    fetchCalls.push({ url: urlString, init });
    if (urlString.endsWith("/api/managed-secrets") && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({
        secrets: [{
          id: "secret_1",
          name: "GITHUB_TOKEN",
          allowedHosts: ["api.github.com"],
          allowedPathPrefixes: ["/"],
          allowedMethods: ["GET"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: null,
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (urlString.endsWith("/api/provider-secrets/runtime-token")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_anthropic",
          bindingSecret: "evrb_anthropic",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: "9999-12-31T23:59:59.999Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlString.endsWith("/api/managed-secrets/runtime-token")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          enabled: true,
          token: "evrt_managed",
          bindingSecret: "evrb_managed",
          egressUrl: "https://dashboard.test/api/managed-secrets/egress",
          channelUrl: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
          expiresAt: "9999-12-31T23:59:59.999Z",
          env: [{
            name: "GITHUB_TOKEN",
            envName: "GITHUB_TOKEN",
            placeholder: "evsec_placeholder",
            allowedHosts: ["api.github.com"],
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlString.endsWith("/api/checkpoints/ckpt_restore")) {
      return new Response(JSON.stringify({
        id: "ckpt_restore",
        hash: "hash_restore",
        tag: "restore-tag",
        sizeBytes: 10,
        timestamp: "2026-01-01T00:00:00.000Z",
        agentType: "claude",
        workspaceMode: "knowledge",
      }), { status: 200 });
    }
    if (urlString.endsWith("/api/checkpoints/presign")) {
      return new Response(JSON.stringify({
        url: "https://storage.example.com/evolve-restore.tar.gz",
      }), { status: 200 });
    }
    if (urlString.endsWith("/api/checkpoints") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "ckpt_after_restore" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function installMalformedRuntimeTokenFetchMock(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = String(url);
    fetchCalls.push({ url: urlString, init });
    if (urlString.endsWith("/api/provider-secrets/runtime-token")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_anthropic",
          bindingSecret: "evrb_anthropic",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: "9999-12-31T23:59:59.999Z",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (urlString.endsWith("/api/managed-secrets/runtime-token") && init?.method === "POST") {
      return new Response(JSON.stringify({
        token: "evrt_managed",
        bindingSecret: "evrb_managed",
        egressUrl: "https://dashboard.test/api/managed-secrets/egress",
        channelUrl: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
        expiresAt: "9999-12-31T23:59:59.999Z",
        env: [{ name: "GITHUB_TOKEN", envName: "GITHUB_TOKEN" }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
}

async function testListClient(): Promise<void> {
  console.log("\n[1] managedSecrets().list() returns metadata only");
  installFetchMock();
  fetchCalls.length = 0;
  const secrets = await managedSecrets({ apiKey: "ev_key", dashboardUrl: "https://dashboard.test" }).list();
  assertEqual(secrets.length, 1, "one secret returned");
  assertEqual(secrets[0].name, "GITHUB_TOKEN", "secret name returned");
  assert(!JSON.stringify(secrets).includes("ghp_real"), "secret value is not returned");
}

function testSandboxEnvAndProxyConfigUsePlaceholders(): void {
  console.log("\n[2] managed secrets produce placeholder envs and proxy config");
  const token: ManagedSecretRuntimeToken = {
    token: "evrt_managed",
    bindingSecret: "evrb_managed",
    egressUrl: "https://dashboard.test/api/managed-secrets/egress",
    channelUrl: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
    expiresAt: "9999-12-31T23:59:59.999Z",
    env: [{
      name: "GITHUB_TOKEN",
      envName: "GITHUB_TOKEN",
      placeholder: "evsec_placeholder",
      allowedHosts: ["api.github.com"],
    }],
  };

  const envs = managedSecretSandboxEnvs(token);
  assertEqual(envs.GITHUB_TOKEN, "evsec_placeholder", "sandbox env contains placeholder");
  assertEqual(envs.HTTPS_PROXY, "http://127.0.0.1:18181", "sandbox env routes HTTPS through local proxy");
  assertEqual(envs.CURL_CA_BUNDLE, "/tmp/evolve-managed-secrets/ca-bundle.crt", "curl uses combined CA bundle");
  assertEqual(envs.REQUESTS_CA_BUNDLE, "/tmp/evolve-managed-secrets/ca-bundle.crt", "requests uses combined CA bundle");
  assertEqual(envs.NODE_EXTRA_CA_CERTS, "/tmp/evolve-managed-secrets/ca.crt", "Node appends local CA to system roots");
  assert(!("NODE_OPTIONS" in envs), "sandbox env does not set NODE_OPTIONS because Node CLIs reject proxy flags");
  assert(!("HTTP_PROXY" in envs), "sandbox env does not route plain HTTP through CONNECT-only proxy");
  assert(!JSON.stringify(envs).includes("ghp_real"), "sandbox env does not contain raw secret");
  const proxyConfig = JSON.parse(managedSecretProxyConfig(token));
  assertEqual(proxyConfig.token, "evrt_managed", "proxy config carries runtime token before cleanup");
  assertEqual(proxyConfig.binding, "evrb_managed", "proxy config carries binding secret before cleanup");
  assertEqual(proxyConfig.channel_url, "https://dashboard.test/api/managed-secrets/runtime-token/channel", "proxy config includes channel registration URL");
  assertEqual(proxyConfig.max_body_bytes, 10 * 1024 * 1024, "proxy config includes request body cap");
  assert(
    managedSecretProxyStartCommand().includes(`python3 /tmp/evolve-managed-secrets/proxy.py ${MANAGED_SECRET_PROXY_CONFIG_PATH}`),
    "proxy start command uses config path",
  );
  assert(managedSecretProxyConfigCleanupCommand().includes(`rm -f ${MANAGED_SECRET_PROXY_CONFIG_PATH}`), "proxy config cleanup removes token material");
  assert(managedSecretCaSetupCommand().includes("ca-bundle.crt"), "proxy CA setup preserves system roots in a combined bundle");
  assert(managedSecretCaSetupCommand().includes("keyUsage=critical,keyCertSign,cRLSign"), "proxy CA has key usage for strict TLS clients");
}

async function testReservedAliasRejected(): Promise<void> {
  console.log("\n[3] managed secret aliases cannot override Evolve envs");
  installFetchMock();
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "ev_key" })
    .withSandbox(provider)
    .withManagedSecrets([{ name: "GITHUB_TOKEN", as: "EVOLVE_API_KEY" }]);

  try {
    await (kit as any).initializeAgent();
    assert(false, "reserved alias should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("reserved"),
      "reserved alias throws a clear error",
    );
  }
}

async function testEvolvePrefixRejected(): Promise<void> {
  console.log("\n[4] managed secret names cannot use EVOLVE_ prefix");
  installFetchMock();
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "ev_key" })
    .withSandbox(provider)
    .withManagedSecrets([{ name: "EVOLVE_FOO" }]);

  try {
    await (kit as any).initializeAgent();
    assert(false, "EVOLVE_ managed secret name should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("EVOLVE_"),
      "EVOLVE_ managed secret name throws a clear error",
    );
  }
}

async function testSetSessionRejected(): Promise<void> {
  console.log("\n[5] withManagedSecrets rejects setSession because grants are sandbox-scoped");
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "ev_key" })
    .withManagedSecrets([{ name: "GITHUB_TOKEN" }]);

  try {
    await kit.setSession("sbx_existing");
    assert(false, "setSession should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("sandbox-scoped"),
      "setSession throws clear sandbox-scoped error",
    );
  }
}

async function testExplicitDirectSandboxRejected(): Promise<void> {
  console.log("\n[6] withManagedSecrets rejects explicit direct sandboxes");
  installFetchMock();
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "ev_key" })
    .withSandbox(provider)
    .withManagedSecrets([{ name: "GITHUB_TOKEN" }]);

  try {
    await (kit as any).initializeAgent();
    assert(false, "direct sandbox should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Evolve-managed sandbox"),
      "direct sandbox error explains managed sandbox requirement",
    );
  }
}

function testAgentConstructorRejectsUnsafeManagedSecretOptions(): void {
  console.log("\n[7] Agent constructor mirrors managed secret safety guards");
  const managedSecretsConfig = {
    apiKey: "ev_key",
    secrets: [{ name: "GITHUB_TOKEN" }],
  };

  try {
    new Agent(
      { type: "claude", apiKey: "ev_key", isDirectMode: false },
      { sandboxProvider: new MockProvider(), sandboxId: "sbx_existing", managedSecrets: managedSecretsConfig },
    );
    assert(false, "Agent managed secrets with sandboxId should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("sandbox-scoped"),
      "Agent rejects managed secrets with existing sandbox",
    );
  }

  try {
    new Agent(
      { type: "claude", apiKey: "anthropic_key", isDirectMode: true },
      { sandboxProvider: new MockProvider(), managedSecrets: managedSecretsConfig },
    );
    assert(false, "Agent managed secrets in direct mode should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("gateway mode"),
      "Agent rejects managed secrets in direct mode",
    );
  }

  try {
    const forgedProvider = new MockProvider() as MockProvider & { isEvolveManaged: boolean };
    forgedProvider.isEvolveManaged = true;
    new Agent(
      { type: "claude", apiKey: "ev_key", isDirectMode: false },
      { sandboxProvider: forgedProvider, managedSecrets: managedSecretsConfig },
    );
    assert(false, "Agent managed secrets with forged managed marker should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Evolve-managed sandbox"),
      "Agent rejects forgeable managed sandbox markers",
    );
  }

  try {
    new Agent(
      { type: "claude", apiKey: "ev_key", isDirectMode: false },
      { sandboxProvider: new MockProvider(), managedSecrets: managedSecretsConfig },
    );
    assert(false, "Agent managed secrets with direct sandbox should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Evolve-managed sandbox"),
      "Agent rejects managed secrets with direct sandbox provider",
    );
  }
}

async function testMalformedRuntimeTokenResponseRejected(): Promise<void> {
  console.log("\n[8] malformed managed secret runtime-token response is rejected");
  installMalformedRuntimeTokenFetchMock();
  fetchCalls.length = 0;

  try {
    await requestManagedSecretRuntimeToken(
      { apiKey: "ev_key" },
      { sessionTag: "session_1", secrets: [{ name: "GITHUB_TOKEN" }] },
    );
    assert(false, "malformed runtime token response should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("Invalid managed secret runtime token response"),
      "malformed runtime token response throws a clear error",
    );
  }
  assert(
    fetchCalls.some((call) => call.url.endsWith("/api/managed-secrets/runtime-token") && call.init?.method === "POST"),
    "runtime-token endpoint was called",
  );
}

async function testManagedSandboxResolverIgnoresDirectKeys(): Promise<void> {
  console.log("\n[9] managed sandbox resolver ignores direct sandbox keys");
  const previousEvolveKey = process.env.EVOLVE_API_KEY;
  const previousE2BKey = process.env.E2B_API_KEY;
  process.env.EVOLVE_API_KEY = "ev_key";
  process.env.E2B_API_KEY = "e2b_direct_key";
  try {
    const provider = await resolveManagedSandbox("ev_key");
    assertEqual(provider.providerType, "e2b", "managed sandbox resolver returns E2B provider");
    assert(!("isEvolveManaged" in provider), "managed sandbox marker is not public or forgeable");
  } finally {
    if (previousEvolveKey === undefined) delete process.env.EVOLVE_API_KEY;
    else process.env.EVOLVE_API_KEY = previousEvolveKey;
    if (previousE2BKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = previousE2BKey;
  }
}

async function testDirectGeminiCanSetAuthTypeSecret(): Promise<void> {
  console.log("\n[10] direct Gemini withSecrets can set GEMINI_DEFAULT_AUTH_TYPE");
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "gemini", providerApiKey: "gemini_key" })
    .withSandbox(provider)
    .withSecrets({ GEMINI_DEFAULT_AUTH_TYPE: "custom-direct-auth" });

  await kit.executeCommand("true", { timeoutMs: 1000 });
  const envs = provider.createOptions?.envs ?? {};
  assertEqual(
    envs.GEMINI_DEFAULT_AUTH_TYPE,
    "custom-direct-auth",
    "direct Gemini preserves user auth type secret",
  );
  await kit.kill();
}

function testProxyDetectsBinaryBodyPlaceholders(): void {
  console.log("\n[11] proxy detects body placeholders without UTF-8 decoding");
  const dir = mkdtempSync(join(tmpdir(), "evolve-managed-secrets-test-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      hosts: ["api.github.com"],
      placeholders: ["evsec_placeholder"],
      base_dir: dir,
      ca_cert: join(dir, "ca.crt"),
      ca_key: join(dir, "ca.key"),
      port: 18181,
      egress_url: "https://dashboard.test/api/managed-secrets/egress",
      channel_url: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
      token: "evrt",
      binding: "evrb",
    }));
    const scriptPath = join(dir, "proxy.py");
    writeFileSync(scriptPath, MANAGED_SECRET_PROXY_SCRIPT);
    const probe = `
import runpy
ns = runpy.run_path(${JSON.stringify(scriptPath)}, run_name="proxy_unit")
body = b"\\xff\\xfe" + b"evsec_placeholder" + b"\\x80\\x81"
print("yes" if ns["uses_placeholder"]("/upload", {}, body) else "no")
`;
    const result = spawnSync("python3", ["-c", probe, configPath], {
      encoding: "utf-8",
    });
    assertEqual(result.status, 0, `proxy probe exits cleanly (${result.stderr.trim()})`);
    assertEqual(result.stdout.trim(), "yes", "binary body placeholder is detected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testProxyPassesThroughRequestsWithoutPlaceholders(): void {
  console.log("\n[13] proxy passes through managed hosts when no placeholder is used");
  const dir = mkdtempSync(join(tmpdir(), "evolve-managed-secrets-test-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      hosts: ["api.github.com"],
      placeholders: ["evsec_placeholder"],
      base_dir: dir,
      ca_cert: join(dir, "ca.crt"),
      ca_key: join(dir, "ca.key"),
      port: 18181,
      egress_url: "https://dashboard.test/api/managed-secrets/egress",
      channel_url: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
      token: "evrt",
      binding: "evrb",
    }));
    const scriptPath = join(dir, "proxy.py");
    writeFileSync(scriptPath, MANAGED_SECRET_PROXY_SCRIPT);
    const probe = `
import runpy
ns = runpy.run_path(${JSON.stringify(scriptPath)}, run_name="proxy_unit")
calls = []
def call_direct(method, url, headers, body):
    calls.append("direct")
    return 204, "No Content", {"headers": {}, "bodyBase64": ""}
def call_dashboard(method, url, headers, body):
    calls.append("dashboard")
    return 200, "OK", {"headers": {}, "bodyBase64": ""}
ns["dispatch_managed_request"].__globals__["call_direct"] = call_direct
ns["dispatch_managed_request"].__globals__["call_dashboard"] = call_dashboard
ns["dispatch_managed_request"]("GET", "https://api.github.com/rate_limit", {"authorization": "Bearer public"}, b"")
ns["dispatch_managed_request"]("GET", "https://api.github.com/user", {"authorization": "Bearer evsec_placeholder"}, b"")
ns["dispatch_managed_request"]("GET", "https://api.github.com/user?access_token=evsec_placeholder", {}, b"")
print(",".join(calls))
`;
    const result = spawnSync("python3", ["-c", probe, configPath], {
      encoding: "utf-8",
    });
    assertEqual(result.status, 0, `proxy dispatch probe exits cleanly (${result.stderr.trim()})`);
    assertEqual(result.stdout.trim(), "direct,dashboard,dashboard", "non-secret traffic passes through; secret traffic uses Dashboard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testProxyCapsDirectResponseReads(): void {
  console.log("\n[14] proxy caps direct response buffering");
  const dir = mkdtempSync(join(tmpdir(), "evolve-managed-secrets-test-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({
      hosts: ["api.github.com"],
      placeholders: ["evsec_placeholder"],
      base_dir: dir,
      ca_cert: join(dir, "ca.crt"),
      ca_key: join(dir, "ca.key"),
      port: 18181,
      egress_url: "https://dashboard.test/api/managed-secrets/egress",
      channel_url: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
      token: "evrt",
      binding: "evrb",
      max_body_bytes: 4,
    }));
    const scriptPath = join(dir, "proxy.py");
    writeFileSync(scriptPath, MANAGED_SECRET_PROXY_SCRIPT);
    const probe = `
import runpy
ns = runpy.run_path(${JSON.stringify(scriptPath)}, run_name="proxy_unit")
class Stream:
    def __init__(self):
        self.parts = [b"1234", b"5", b""]
    def read(self, _size):
        return self.parts.pop(0)
try:
    ns["read_limited_response"](Stream())
    print("missing-error")
except RuntimeError as exc:
    print(str(exc))
`;
    const result = spawnSync("python3", ["-c", probe, configPath], {
      encoding: "utf-8",
    });
    assertEqual(result.status, 0, `proxy capped-read probe exits cleanly (${result.stderr.trim()})`);
    assertEqual(result.stdout.trim(), "response body too large", "direct response cap is enforced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testListClient();
  testSandboxEnvAndProxyConfigUsePlaceholders();
  await testReservedAliasRejected();
  await testEvolvePrefixRejected();
  await testSetSessionRejected();
  await testExplicitDirectSandboxRejected();
  testAgentConstructorRejectsUnsafeManagedSecretOptions();
  await testMalformedRuntimeTokenResponseRejected();
  await testManagedSandboxResolverIgnoresDirectKeys();
  await testDirectGeminiCanSetAuthTypeSecret();
  testProxyDetectsBinaryBodyPlaceholders();
  testProxyPassesThroughRequestsWithoutPlaceholders();
  testProxyCapsDirectResponseReads();
  console.log(`\nManaged secrets tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
