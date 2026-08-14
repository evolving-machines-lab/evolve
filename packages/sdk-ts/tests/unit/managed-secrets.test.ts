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
  managedSecretTokenNeedsProxy,
  MANAGED_SECRET_PROXY_CONFIG_PATH,
  MANAGED_SECRET_PROXY_SCRIPT,
  managedSecrets,
  normalizeManagedSecretRefs,
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

function testDirectDeliveryBypassesProxy(): void {
  console.log("\n[2b] direct delivery lands raw env; the proxy serves only brokered entries");
  const mixed: ManagedSecretRuntimeToken = {
    token: "evrt_managed",
    bindingSecret: "evrb_managed",
    egressUrl: "https://dashboard.test/api/managed-secrets/egress",
    channelUrl: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
    expiresAt: "9999-12-31T23:59:59.999Z",
    env: [
      {
        name: "GITHUB_TOKEN",
        envName: "GITHUB_TOKEN",
        delivery: "brokered",
        placeholder: "evsec_placeholder",
        allowedHosts: ["api.github.com"],
      },
      {
        name: "GRPC_API_KEY",
        envName: "GRPC_API_KEY",
        delivery: "direct",
        value: "raw_grpc_value",
        allowedHosts: [],
      },
    ],
  };
  assert(managedSecretTokenNeedsProxy(mixed), "a mixed token still needs the proxy");
  const envs = managedSecretSandboxEnvs(mixed);
  assertEqual(envs.GRPC_API_KEY, "raw_grpc_value", "direct entry is the raw value in the sandbox env");
  assertEqual(envs.GITHUB_TOKEN, "evsec_placeholder", "brokered entry stays a placeholder");
  const proxyConfig = JSON.parse(managedSecretProxyConfig(mixed));
  assertEqual(proxyConfig.placeholders.length, 1, "proxy config carries only the brokered placeholder");
  assert(
    !JSON.stringify(proxyConfig).includes("raw_grpc_value"),
    "the proxy never learns the direct value",
  );
  assert(
    !proxyConfig.hosts.includes("") && proxyConfig.hosts.length === 1,
    "proxy hosts come from brokered entries only",
  );

  const allDirect: ManagedSecretRuntimeToken = {
    ...mixed,
    env: [mixed.env[1]],
  };
  assert(!managedSecretTokenNeedsProxy(allDirect), "an all-direct token skips the proxy entirely");
  const directEnvs = managedSecretSandboxEnvs(allDirect);
  assertEqual(directEnvs.GRPC_API_KEY, "raw_grpc_value", "all-direct env carries the raw value");
  assert(!("HTTPS_PROXY" in directEnvs), "all-direct env sets no proxy routing");
  assert(!("SSL_CERT_FILE" in directEnvs), "all-direct env sets no CA overrides");
}

function testLabelRefsNormalized(): void {
  console.log("\n[2c] label refs pass the shared grammar and ride the wire");
  const refs = normalizeManagedSecretRefs([
    { name: "github_token", label: "prod", as: "gh_token" },
    { name: "PLAIN" },
  ]);
  assertEqual(refs[0].name, "GITHUB_TOKEN", "name is normalized upper-case");
  assertEqual(refs[0].label, "prod", "label rides through untouched");
  assertEqual(refs[0].as, "GH_TOKEN", "alias is normalized upper-case");
  assertEqual(refs[1].label, undefined, "an omitted label stays omitted — the server's defaulting law rules");
  try {
    normalizeManagedSecretRefs([{ name: "TOKEN", label: "bad label!" }]);
    assert(false, "a malformed label should throw");
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes("label"),
      "malformed label names the field",
    );
  }
}

async function testDirectDeliveryRuntimeTokenAccepted(): Promise<void> {
  console.log("\n[2d] a runtime token carrying direct entries passes the response validator");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = String(url);
    if (urlString.endsWith("/api/managed-secrets/runtime-token") && init?.method === "POST") {
      return new Response(JSON.stringify({
        enabled: true,
        token: "evrt_managed",
        bindingSecret: "evrb_managed",
        egressUrl: "https://dashboard.test/api/managed-secrets/egress",
        channelUrl: "https://dashboard.test/api/managed-secrets/runtime-token/channel",
        expiresAt: "9999-12-31T23:59:59.999Z",
        env: [{
          name: "GRPC_API_KEY",
          envName: "GRPC_API_KEY",
          delivery: "direct",
          value: "raw_grpc_value",
          allowedHosts: [],
        }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const token = await requestManagedSecretRuntimeToken(
    { apiKey: "ev_key", dashboardUrl: "https://dashboard.test" },
    { sessionTag: "session_1", secrets: [{ name: "GRPC_API_KEY" }] },
  );
  assertEqual(token.env[0].delivery, "direct", "direct entry survives validation");
  assertEqual(token.env[0].value, "raw_grpc_value", "direct value survives validation");
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

function runProxyProbe(
  probe: string,
  configOverrides: Record<string, unknown> = {},
): { status: number | null; stdout: string; stderr: string } {
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
      ...configOverrides,
    }));
    const scriptPath = join(dir, "proxy.py");
    writeFileSync(scriptPath, MANAGED_SECRET_PROXY_SCRIPT);
    const result = spawnSync(
      "python3",
      ["-c", `SCRIPT = ${JSON.stringify(scriptPath)}\n${probe}`, configPath],
      { encoding: "utf-8" },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testProxyPropagatesUpstreamStatus(): void {
  console.log("\n[15] brokered replies carry the upstream status, not the dashboard's");
  const probe = `
import base64, json, runpy, urllib.request
ns = runpy.run_path(SCRIPT, run_name="proxy_unit")

class FakeResponse:
    def __init__(self, status, reason, payload):
        self.status = status
        self.reason = reason
        self._payload = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._payload
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False

def responder(payload, status=200, reason="OK"):
    def fake_urlopen(req, timeout=None):
        return FakeResponse(status, reason, payload)
    return fake_urlopen

# The dashboard hop succeeded (200) while the real upstream returned 503.
urllib.request.urlopen = responder({
    "status": 503,
    "statusText": "Service Unavailable",
    "headers": {"content-type": "application/json"},
    "bodyBase64": base64.b64encode(b'{"error":"upstream down"}').decode("ascii"),
})
status, reason, result = ns["call_dashboard"]("GET", "https://api.github.com/user", {}, b"")
print(status, reason, base64.b64decode(result["bodyBase64"]).decode())

# A server older than the status lane omits it: the transport status stands.
urllib.request.urlopen = responder({"headers": {}, "bodyBase64": ""})
legacy_status, legacy_reason, _ = ns["call_dashboard"]("GET", "https://api.github.com/user", {}, b"")
print(legacy_status, legacy_reason)
`;
  const result = runProxyProbe(probe);
  assertEqual(result.status, 0, `proxy status probe exits cleanly (${result.stderr.trim()})`);
  const lines = result.stdout.trim().split("\n");
  assertEqual(
    lines[0],
    '503 Service Unavailable {"error":"upstream down"}',
    "a 200-wrapped 503 reaches the agent as 503 with the upstream body",
  );
  assertEqual(lines[1], "200 OK", "a payload without a status falls back to the dashboard's status");
}

function testProxyAnswersTypedGatewayErrorOnEgressFailure(): void {
  console.log("\n[16] egress failure becomes a typed 502 instead of killing the connection");
  const probe = `
import base64, json, runpy, ssl, urllib.error, urllib.request
ns = runpy.run_path(SCRIPT, run_name="proxy_unit")

def ssl_eof(req, timeout=None):
    raise urllib.error.URLError(ssl.SSLEOFError("EOF occurred in violation of protocol"))
urllib.request.urlopen = ssl_eof
status, reason, result = ns["call_dashboard"]("GET", "https://api.github.com/user", {}, b"")
body = json.loads(base64.b64decode(result["bodyBase64"]).decode())
print(status, reason, result["headers"]["content-type"], body["error"])

def reset(req, timeout=None):
    raise ConnectionResetError(104, "Connection reset by peer")
urllib.request.urlopen = reset
reset_status, _, _ = ns["call_dashboard"]("GET", "https://api.github.com/user", {}, b"")
print(reset_status)
`;
  const result = runProxyProbe(probe);
  assertEqual(result.status, 0, `proxy egress-failure probe exits cleanly (${result.stderr.trim()})`);
  const lines = result.stdout.trim().split("\n");
  assertEqual(
    lines[0],
    "502 Managed Secret Egress Unavailable application/json managed secret egress request failed",
    "an SSL EOF is answered as a typed 502 naming the egress failure",
  );
  assertEqual(lines[1], "502", "a connection reset is answered as a typed 502 too");
}

function testProxyListenerSurvivesConnectionFailures(): void {
  console.log("\n[17] the listener survives a failure and answers the next request");
  const probe = `
import runpy, socket as real_socket, threading, time
ns = runpy.run_path(SCRIPT, run_name="proxy_unit")

picker = real_socket.socket()
picker.bind(("127.0.0.1", 0))
port = picker.getsockname()[1]
picker.close()
ns["CONFIG"]["port"] = port

class FlakyServerSocket:
    def __init__(self, inner):
        self._inner = inner
        self._failed = False
    def setsockopt(self, *args):
        return self._inner.setsockopt(*args)
    def bind(self, *args):
        return self._inner.bind(*args)
    def listen(self, *args):
        return self._inner.listen(*args)
    def accept(self):
        if not self._failed:
            self._failed = True
            raise OSError(24, "Too many open files")
        return self._inner.accept()

class SocketShim:
    AF_INET = real_socket.AF_INET
    SOCK_STREAM = real_socket.SOCK_STREAM
    SOL_SOCKET = real_socket.SOL_SOCKET
    SO_REUSEADDR = real_socket.SO_REUSEADDR
    @staticmethod
    def socket(*args, **kwargs):
        return FlakyServerSocket(real_socket.socket(*args, **kwargs))

handled = []
def flaky_handle_client(client):
    handled.append(1)
    # Drain first: closing a socket with unread bytes sends RST, which would
    # reach the client as a connection error instead of a clean close.
    try:
        client.recv(4096)
    except OSError:
        pass
    if len(handled) == 1:
        client.close()
        raise RuntimeError("handler exploded")
    client.sendall(b"HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok")
    client.close()

ns["serve"].__globals__["socket"] = SocketShim
ns["serve"].__globals__["handle_client"] = flaky_handle_client
threading.Thread(target=ns["serve"], daemon=True).start()

def request():
    conn = real_socket.create_connection(("127.0.0.1", port), timeout=5)
    try:
        conn.sendall(b"CONNECT api.github.com:443 HTTP/1.1\\r\\n\\r\\n")
        return conn.recv(4096)
    finally:
        conn.close()

deadline = time.time() + 10
while True:
    try:
        request()
        break
    except OSError:
        if time.time() > deadline:
            raise
        time.sleep(0.05)

second = request()
print(len(handled), second.decode().splitlines()[0])
`;
  const result = runProxyProbe(probe);
  assertEqual(result.status, 0, `proxy listener probe exits cleanly (${result.stderr.trim()})`);
  assertEqual(
    result.stdout.trim(),
    "2 HTTP/1.1 200 OK",
    "a failed accept and a throwing handler leave the listener serving the next request",
  );
}

async function main(): Promise<void> {
  await testListClient();
  testSandboxEnvAndProxyConfigUsePlaceholders();
  testDirectDeliveryBypassesProxy();
  testLabelRefsNormalized();
  await testDirectDeliveryRuntimeTokenAccepted();
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
  testProxyPropagatesUpstreamStatus();
  testProxyAnswersTypedGatewayErrorOnEgressFailure();
  testProxyListenerSurvivesConnectionFailures();
  console.log(`\nManaged secrets tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
