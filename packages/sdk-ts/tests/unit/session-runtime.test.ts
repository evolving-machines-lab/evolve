#!/usr/bin/env tsx
/**
 * Unit Test: Session Runtime APIs
 *
 * Covers Group 1 runtime surface:
 * - lifecycle event stream
 * - status()
 * - interrupt()
 * - state transition safety under pause/kill/interrupt
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Evolve, type LifecycleEvent } from "../../dist/index.js";
import { E2BCommands, E2BFiles } from "@evolvingmachines/e2b";
import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCreateOptions,
  SandboxCommands,
  SandboxFiles,
  SandboxRunOptions,
  SandboxSpawnOptions,
  SandboxCommandHandle,
  SandboxCommandResult,
  ProcessInfo,
} from "../../src/types.js";

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

/**
 * The artifact listing command emits `find ... -printf '%p\0%s\0' | base64 -w0`.
 * Mocks must (a) match it via the substring "find --" (the full command is now
 * prefixed with `set -o pipefail`) and (b) return the NUL-delimited records
 * base64-encoded, exactly as the in-box `base64 -w0` produces them, so the SDK's
 * transport-resilient decode path is exercised.
 */
function isArtifactListing(command: string): boolean {
  return command.includes("find --");
}
function artifactListingStdout(rawNulDelimited: string): string {
  return Buffer.from(rawNulDelimited, "utf8").toString("base64");
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type RuntimeProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "dashscope"
  | "kimi"
  | "openrouter"
  | "droid"
  | "pi"
  | "prime-agent"
  | "dsh"
  | "zcode"
  | "antigravity";

function runtimeTokenResponse(provider: RuntimeProvider = "anthropic") {
  const openAiCompatible = new Set<RuntimeProvider>([
    "openai",
    "dashscope",
    "kimi",
    "openrouter",
    "droid",
    "pi",
    "prime-agent",
    "dsh",
    "zcode",
  ]);
  const suffix = openAiCompatible.has(provider) ? "/v1" : "";
  const baseUrl = `https://dashboard.test/api/model-proxy/${provider}${suffix}`;
  return {
    enabled: true,
    provider,
    credentialMode: "evolve_key",
    token: `evrt_${provider}`,
    bindingSecret: `evrb_${provider}`,
    baseUrl,
    expiresAt: "9999-12-31T23:59:59.999Z",
  };
}

class MockFiles implements SandboxFiles {
  public writes = new Map<string, string>();
  public dirs: string[] = [];

  async read(path: string): Promise<string | Uint8Array> {
    const value = this.writes.get(path);
    if (value === undefined) throw new Error("not found");
    return value;
  }
  async write(
    path: string,
    content: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    this.writes.set(path, String(content));
  }
  async writeBatch(
    _files: Array<{
      path: string;
      data: string | Buffer | ArrayBuffer | Uint8Array;
    }>,
  ): Promise<void> {}
  async makeDir(path: string): Promise<void> {
    this.dirs.push(path);
  }
}

type SpawnMode = "instant" | "hang";

class MockCommands implements SandboxCommands {
  public spawned: string[] = [];
  public spawnOptions: Array<SandboxSpawnOptions | undefined> = [];
  public runCommands: string[] = [];
  public runHandler?: (
    command: string,
    options?: SandboxRunOptions,
  ) => SandboxCommandResult;
  public mode: SpawnMode = "instant";
  /** The stdout lines an instant spawn prints (one noop line by default). */
  public stdoutScript: string[] | null = null;
  /** The exit code an instant, uninterrupted spawn reports. */
  public exitCode = 0;
  public killSucceeds = true;
  public activeHandle: SandboxCommandHandle | null = null;

  async run(
    command: string,
    options?: SandboxRunOptions,
  ): Promise<SandboxCommandResult> {
    this.runCommands.push(command);
    if (this.runHandler) return this.runHandler(command, options);
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async spawn(
    command: string,
    options?: SandboxSpawnOptions,
  ): Promise<SandboxCommandHandle> {
    this.spawned.push(command);
    this.spawnOptions.push(options);
    const processId = `p-${this.spawned.length}`;

    let finished = false;
    let interrupted = false;
    let resolveWait: ((r: SandboxCommandResult) => void) | null = null;

    const waitPromise = new Promise<SandboxCommandResult>((resolve) => {
      resolveWait = resolve;
    });

    const handle: SandboxCommandHandle = {
      processId,
      wait: async () => waitPromise,
      kill: async () => {
        if (!this.killSucceeds) return false;
        if (finished) return false;
        interrupted = true;
        finished = true;
        resolveWait?.({
          exitCode: 130,
          stdout: "",
          stderr: "interrupted",
        });
        return true;
      },
    };

    this.activeHandle = handle;

    if (this.mode === "instant") {
      setTimeout(() => {
        if (finished) return;
        for (const line of this.stdoutScript ?? ['{"type":"noop"}']) options?.onStdout?.(line + "\n");
        finished = true;
        resolveWait?.({
          exitCode: interrupted ? 130 : this.exitCode,
          stdout: interrupted ? "" : "ok",
          stderr: "",
        });
      }, 10);
    }

    return handle;
  }

  async list(): Promise<ProcessInfo[]> {
    if (!this.activeHandle) return [];
    return [
      {
        processId: this.activeHandle.processId,
        cmd: "mock",
        args: [],
        envs: {},
      },
    ];
  }

  async kill(processId: string): Promise<boolean> {
    if (!this.activeHandle || this.activeHandle.processId !== processId) {
      return false;
    }
    return this.activeHandle.kill();
  }
}

class MockSandbox implements SandboxInstance {
  readonly sandboxId: string;
  readonly commands: MockCommands;
  readonly files: MockFiles;
  public killed = false;

  constructor(id: string, commands: MockCommands) {
    this.sandboxId = id;
    this.commands = commands;
    this.files = new MockFiles();
  }

  async getHost(port: number): Promise<string> {
    return `http://localhost:${port}`;
  }

  async kill(): Promise<void> {
    this.killed = true;
    await this.commands.activeHandle?.kill();
  }

  async pause(): Promise<void> {
    await this.commands.activeHandle?.kill();
  }
}

class MockProvider implements SandboxProvider {
  readonly providerType = "mock";
  readonly name = "mock";
  public connectCalls = 0;
  public createCalls = 0;
  public createOptions?: SandboxCreateOptions;

  constructor(private readonly sandbox: MockSandbox) {}

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    this.createCalls++;
    this.createOptions = options;
    return this.sandbox;
  }

  async connect(
    _sandboxId: string,
    _timeoutMs?: number,
  ): Promise<SandboxInstance> {
    this.connectCalls++;
    return this.sandbox;
  }
}

async function testStatusAndLifecycle(): Promise<void> {
  console.log("\n[1] status() + lifecycle stream");
  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-1", commands);
  const provider = new MockProvider(sandbox);

  const events: LifecycleEvent[] = [];

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider)
    .withSession("sess-1");

  kit.on("lifecycle", (event) => events.push(event));

  const before = await kit.status();
  assertEqual(
    before.sandbox,
    "ready",
    "status() before run reports ready for attached session",
  );
  assertEqual(before.agent, "idle", "status() before run reports idle agent");
  assertEqual(
    before.hasRun,
    true,
    "status() before run reports hasRun=true for attached session",
  );
  assert(Boolean(before.timestamp), "status() exposes timestamp");

  const result = await kit.run({ prompt: "test prompt", timeoutMs: 10_000 });
  assertEqual(result.exitCode, 0, "run() returns success");

  const after = await kit.status();
  assertEqual(after.sandbox, "ready", "status() after run reports ready");
  assertEqual(after.agent, "idle", "status() after run reports idle");
  assertEqual(after.hasRun, true, "status() after run reports hasRun=true");
  assert(Boolean(after.timestamp), "status() after run exposes timestamp");

  const reasons = events.map((e) => e.reason);
  assert(reasons.includes("sandbox_boot"), "lifecycle includes sandbox_boot");
  assert(
    reasons.includes("sandbox_connected"),
    "lifecycle includes sandbox_connected",
  );
  assert(reasons.includes("run_start"), "lifecycle includes run_start");
  assert(reasons.includes("run_complete"), "lifecycle includes run_complete");
  assert(
    events.every((e) => e.sandboxId !== undefined),
    "all lifecycle events include sandboxId",
  );
}

async function testPrepareSandboxDoesNotStartAgent(): Promise<void> {
  console.log("\n[1a] prepareSandbox() creates a durable execution boundary");
  const commands = new MockCommands();
  const sandbox = new MockSandbox("prepared-session", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider);

  const sandboxId = await kit.prepareSandbox();

  assertEqual(sandboxId, "prepared-session", "prepareSandbox() returns the sandbox ID");
  assertEqual(provider.createCalls, 1, "prepareSandbox() creates the sandbox once");
  assertEqual(commands.spawned.length, 0, "prepareSandbox() does not start the agent command");
  assertEqual(kit.getSessionTag() !== null, true, "prepared sandbox exposes its session tag");

  await kit.run({ prompt: "start after durable handoff", timeoutMs: 10_000 });
  assertEqual(provider.createCalls, 1, "run() reuses the prepared sandbox");
  assertEqual(commands.spawned.length, 1, "run() starts exactly one agent command");
  await kit.kill();
}

async function testWithSecretsEvolveApiKeyBoundary(): Promise<void> {
  console.log("\n[2] withSecrets() preserves direct EVOLVE_API_KEY but blocks gateway override");

  const directCommands = new MockCommands();
  const directProvider = new MockProvider(
    new MockSandbox("direct-secrets", directCommands),
  );
  const direct = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "anthropic-key" })
    .withSandbox(directProvider)
    .withSecrets({ EVOLVE_API_KEY: "raw-user-env" });

  await direct.executeCommand("true", { timeoutMs: 1000 });
  const directEnvs = directProvider.createOptions?.envs ?? {};
  assertEqual(
    directEnvs.EVOLVE_API_KEY,
    "raw-user-env",
    "direct mode preserves user-supplied EVOLVE_API_KEY",
  );

  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(JSON.stringify(runtimeTokenResponse("anthropic")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const gatewayProvider = new MockProvider(
      new MockSandbox("gateway-secrets", new MockCommands()),
    );
    const gateway = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(gatewayProvider)
      .withSecrets({ EVOLVE_API_KEY: "raw-user-env" });

    let threw = false;
    try {
      await gateway.executeCommand("true", { timeoutMs: 1000 });
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      assert(
        message.includes("EVOLVE_API_KEY is reserved"),
        "gateway mode throws clear reserved-key error",
      );
    }

    assertEqual(threw, true, "gateway mode rejects EVOLVE_API_KEY");
    assertEqual(
      gatewayProvider.createCalls,
      0,
      "gateway mode rejects before sandbox creation",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined) delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testKillFlushesSessionEnd(): Promise<void> {
  console.log("\n[2a] kill() flushes session end marker");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  const ingestBodies: Array<{ events?: unknown[] }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify(runtimeTokenResponse()),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      (init?.method === "PATCH" || init?.method === "DELETE")
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      ingestBodies.push(JSON.parse(String(init?.body || "{}")));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-end", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    await kit.run({ prompt: "test", timeoutMs: 10_000 });
    await kit.kill();
    const events = ingestBodies.flatMap((body) => body.events ?? []);
    assert(
      events.some(
        (event) =>
          Boolean(event) && typeof event === "object" && "_sessionEnd" in event,
      ),
      "kill() flushes _sessionEnd to dashboard ingest",
    );
    assert(
      ingestBodies.length > 0 && ingestBodies.every((body) => body.reasoningEffort === "high"),
      "every ingest body carries the effort the run resolved — claude's registry pin (B181)",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testManagedBrowserLifecycle(): Promise<void> {
  console.log("\n[2] managed browser live URL lifecycle");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";

  const liveUrl =
    "https://dashboard.test/browser-sessions/browser_123/live?token=view-token";
  const cdpUrl =
    "wss://dashboard.test/api/browser-sessions/browser_123/cdp?token=proxy-token";

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify(runtimeTokenResponse()),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      (init?.method === "PATCH" || init?.method === "DELETE")
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/browser-sessions" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          id: "browser_123",
          sessionId: "session_db_123",
          sessionTag: "evolve-browser",
          cdpUrl,
          liveUrl,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (
      url === "https://dashboard.test/api/browser-sessions/browser_123" &&
      init?.method === "DELETE"
    ) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/sessions/ingest")) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-browser", commands);
  const provider = new MockProvider(sandbox);
  const events: LifecycleEvent[] = [];

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider)
    .withBrowser();

  kit.on("lifecycle", (event) => events.push(event));

  try {
    const result = await kit.run({ prompt: "test prompt", timeoutMs: 10_000 });
    assertEqual(
      result.exitCode,
      0,
      "run() with managed browser returns success",
    );
    assertEqual(
      result.sessionId,
      "session_db_123",
      "run() exposes Dashboard session id",
    );
    assertEqual(
      result.browser?.liveUrl,
      liveUrl,
      "run() exposes managed browser live URL",
    );
    assert(
      !JSON.stringify(provider.createOptions?.envs).includes("proxy-token"),
      "sandbox env does not include CDP token",
    );

    assertEqual(
      provider.createOptions?.envs?.AGENT_BROWSER_CONFIG,
      "/home/user/.agent-browser/config.json",
      "sandbox env points agent-browser to managed config",
    );
    const config = sandbox.files.writes.get(
      "/home/user/.agent-browser/config.json",
    );
    assert(
      sandbox.files.dirs.includes("/home/user/.agent-browser"),
      "agent-browser config directory created",
    );
    assert(config !== undefined, "agent-browser config file written");
    assert(
      config?.includes(cdpUrl) ?? false,
      "agent-browser config uses proxied CDP endpoint",
    );
    assert(
      !config?.includes("_managedTransport"),
      "agent-browser config does not expose transport selector",
    );

    const browserReady = events.find(
      (event) => event.reason === "browser_ready",
    );
    assertEqual(
      browserReady?.browser?.liveUrl,
      liveUrl,
      "browser_ready exposes live URL immediately",
    );
    assertEqual(
      browserReady?.browser?.sessionId,
      "session_db_123",
      "browser_ready exposes Dashboard session id",
    );
    assert(
      events.findIndex((event) => event.reason === "browser_ready") <
        events.findIndex((event) => event.reason === "sandbox_ready"),
      "browser_ready is emitted before sandbox ready",
    );

    const status = await kit.status();
    assertEqual(
      status.browser?.liveUrl,
      liveUrl,
      "status() exposes managed browser live URL",
    );
  } finally {
    await kit.kill();
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined) {
      delete process.env.EVOLVE_DASHBOARD_URL;
    } else {
      process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
    }
  }
}

async function testManagedAgentBrowserLifecycle(): Promise<void> {
  console.log("\n[3] managed agent-browser config lifecycle");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";

  const liveUrl =
    "https://dashboard.test/browser-sessions/browser_456/live?token=view-token";
  const cdpUrl =
    "wss://dashboard.test/api/browser-sessions/browser_456/cdp?token=proxy-token";
  let createBody: any;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify(runtimeTokenResponse()),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      (init?.method === "PATCH" || init?.method === "DELETE")
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/browser-sessions" &&
      init?.method === "POST"
    ) {
      createBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: "browser_456",
          sessionId: "session_db_456",
          sessionTag: "evolve-agent-browser",
          cdpUrl,
          liveUrl,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (
      url === "https://dashboard.test/api/browser-sessions/browser_456" &&
      init?.method === "DELETE"
    ) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/sessions/ingest")) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-agent-browser", commands);
  const provider = new MockProvider(sandbox);
  const events: LifecycleEvent[] = [];

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider)
    .withBrowser({ provider: "agent-browser", remote: true });

  kit.on("lifecycle", (event) => events.push(event));

  try {
    const result = await kit.run({ prompt: "test prompt", timeoutMs: 10_000 });
    assertEqual(
      result.exitCode,
      0,
      "run() with managed agent-browser returns success",
    );
    assert(
      !("provider" in createBody),
      "managed browser create does not expose automation provider",
    );
    assertEqual(
      createBody.options?.remote,
      true,
      "managed browser create uses remote option",
    );
    assertEqual(
      createBody.browserAuth,
      false,
      "managed browser create does not request browser auth by default",
    );
    assert(
      !("_managedTransport" in createBody.options),
      "managed browser create does not expose transport selector",
    );
    assertEqual(
      result.browser?.liveUrl,
      liveUrl,
      "run() exposes managed agent-browser live URL",
    );
    assertEqual(
      provider.createOptions?.envs?.AGENT_BROWSER_CONFIG,
      "/home/user/.agent-browser/config.json",
      "sandbox env points agent-browser to managed config",
    );
    assert(
      !JSON.stringify(provider.createOptions?.envs).includes("proxy-token"),
      "sandbox env does not include CDP token",
    );

    const config = sandbox.files.writes.get(
      "/home/user/.agent-browser/config.json",
    );
    assert(
      sandbox.files.dirs.includes("/home/user/.agent-browser"),
      "agent-browser config directory created",
    );
    assert(config !== undefined, "agent-browser config file written");
    const parsedConfig = JSON.parse(config!);
    assert(
      !("session" in parsedConfig),
      "agent-browser config leaves session default to agent-browser",
    );
    assert(
      config?.includes(cdpUrl) ?? false,
      "agent-browser config uses proxied CDP endpoint",
    );
    assert(
      !config?.includes("_managedTransport"),
      "agent-browser config does not expose transport selector",
    );

    const browserReady = events.find(
      (event) => event.reason === "browser_ready",
    );
    assertEqual(
      browserReady?.browser?.liveUrl,
      liveUrl,
      "browser_ready exposes agent-browser live URL",
    );
    assertEqual(
      browserReady?.browser?.sessionId,
      "session_db_456",
      "browser_ready exposes agent-browser Dashboard session id",
    );
  } finally {
    await kit.kill();
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined) {
      delete process.env.EVOLVE_DASHBOARD_URL;
    } else {
      process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
    }
  }
}

async function testInterrupt(): Promise<void> {
  console.log("\n[4] interrupt() semantics and lifecycle");
  const commands = new MockCommands();
  commands.mode = "hang";
  const sandbox = new MockSandbox("sess-2", commands);
  const provider = new MockProvider(sandbox);

  const events: LifecycleEvent[] = [];

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider)
    .withSession("sess-2");

  kit.on("lifecycle", (event) => events.push(event));

  const runPromise = kit.run({ prompt: "long task", timeoutMs: 60_000 });

  await waitFor(() => commands.activeHandle !== null);
  await sleep(20);

  const running = await kit.status();
  assertEqual(
    running.sandbox,
    "running",
    "status() while active run reports running sandbox",
  );
  assertEqual(
    running.agent,
    "running",
    "status() while active run reports running agent",
  );

  commands.killSucceeds = false;
  const failedInterrupt = await kit.interrupt();
  assertEqual(
    failedInterrupt,
    false,
    "interrupt() returns false when kill cannot be performed",
  );
  const stillRunning = await kit.status();
  assertEqual(
    stillRunning.agent,
    "running",
    "failed interrupt keeps agent in running state",
  );

  commands.killSucceeds = true;
  const interrupted = await kit.interrupt();
  assertEqual(
    interrupted,
    true,
    "interrupt() returns true when process is active",
  );

  const result = await runPromise;
  assertEqual(result.exitCode, 130, "interrupted run exits with code 130");

  const after = await kit.status();
  assertEqual(
    after.sandbox,
    "ready",
    "status() after interrupt reports ready sandbox",
  );
  assertEqual(
    after.agent,
    "interrupted",
    "status() after interrupt reports interrupted agent",
  );

  const reasons = events.map((e) => e.reason);
  assertEqual(
    reasons.filter((reason) => reason === "run_interrupted").length,
    1,
    "lifecycle emits run_interrupted exactly once",
  );

  const interruptedWhenIdle = await kit.interrupt();
  assertEqual(
    interruptedWhenIdle,
    false,
    "interrupt() returns false when no active process",
  );
}

async function testBackgroundCompletionLifecycle(): Promise<void> {
  console.log("\n[5] background completion emits lifecycle event");
  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-3", commands);
  const provider = new MockProvider(sandbox);

  const events: LifecycleEvent[] = [];
  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider)
    .withSession("sess-3");
  kit.on("lifecycle", (event) => events.push(event));

  const run = await kit.run({ prompt: "turn 1", background: true });
  assertEqual(run.exitCode, 0, "background run handshake succeeds");
  await waitFor(() =>
    events.some((event) => event.reason === "run_background_complete"),
  );
}

async function testPauseAndKillDoNotGetOverwritten(): Promise<void> {
  console.log(
    "\n[6] pause()/kill() state is not overwritten by stale completion",
  );
  const commands = new MockCommands();
  commands.mode = "hang";
  const sandbox = new MockSandbox("sess-4", commands);
  const provider = new MockProvider(sandbox);

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider)
    .withSession("sess-4");

  const pauseRun = kit.run({ prompt: "long task", timeoutMs: 60_000 });
  await waitFor(() => commands.activeHandle !== null);
  await kit.pause();
  await pauseRun;

  const paused = await kit.status();
  assertEqual(
    paused.sandbox,
    "paused",
    "pause() leaves sandbox in paused state",
  );
  assertEqual(paused.agent, "idle", "pause() leaves agent idle");

  await kit.resume();
  const resumed = await kit.status();
  assertEqual(resumed.sandbox, "ready", "resume() restores ready state");

  const killRun = kit.run({ prompt: "long task 2", timeoutMs: 60_000 });
  await waitFor(() => commands.activeHandle !== null);
  await kit.kill();
  await killRun;

  const killed = await kit.status();
  assertEqual(killed.sandbox, "stopped", "kill() leaves sandbox stopped");
  assertEqual(killed.agent, "idle", "kill() leaves agent idle");
}

async function testConcurrentRunFailsFast(): Promise<void> {
  console.log("\n[7] same-instance concurrent run() fails fast");
  const commands = new MockCommands();
  commands.mode = "hang";
  const sandbox = new MockSandbox("sess-5", commands);
  const provider = new MockProvider(sandbox);

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider)
    .withSession("sess-5");

  const firstRun = kit.run({ prompt: "long task", timeoutMs: 60_000 });
  await waitFor(() => commands.activeHandle !== null);
  await sleep(20);

  let threw = false;
  try {
    await kit.run({ prompt: "second task", timeoutMs: 5_000 });
  } catch (error) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("Agent is already running"),
      "second concurrent run throws clear already-running error",
    );
  }

  assertEqual(threw, true, "second concurrent run throws immediately");
  await kit.interrupt();
  await firstRun;
}

async function testSetSessionFailsWhenActiveCannotInterrupt(): Promise<void> {
  console.log(
    "\n[8] setSession() fails if active process cannot be interrupted",
  );
  const commands = new MockCommands();
  commands.mode = "hang";
  commands.killSucceeds = false;
  const sandbox = new MockSandbox("sess-6", commands);
  const provider = new MockProvider(sandbox);

  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider)
    .withSession("sess-6");

  const firstRun = kit.run({ prompt: "long task", timeoutMs: 60_000 });
  await waitFor(() => kit.status().agent === "running");

  let threw = false;
  try {
    await kit.setSession("sess-6b");
  } catch (error) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(
        "Cannot switch session while an active process is running",
      ),
      "setSession() throws clear error when interruption fails",
    );
  }
  assertEqual(
    threw,
    true,
    "setSession() rejects when active process cannot be interrupted",
  );

  commands.killSucceeds = true;
  await kit.interrupt();
  await firstRun;
}

async function testProviderRuntimeEndpointMissingFailsClosed(): Promise<void> {
  console.log(
    "\n[10] missing provider runtime token endpoint fails closed",
  );
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  let runtimeTokenCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      runtimeTokenCalls++;
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  const sandbox = new MockSandbox("sess-byok-fail", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    let threw = false;
    try {
      await kit.run({ prompt: "test", timeoutMs: 10_000 });
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      assert(
        message.includes("runtime token endpoint is required"),
        "missing runtime-token endpoint throws clear fail-closed error",
      );
    }
    assertEqual(threw, true, "run() rejects before sandbox creation");
    assertEqual(
      runtimeTokenCalls,
      1,
      "missing runtime-token endpoint is requested once",
    );
    assertEqual(provider.createCalls, 0, "sandbox is not created");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testProviderRuntimeTokenServerErrorFailsClosed(): Promise<void> {
  console.log("\n[10a] provider runtime token server error fails closed");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  const sandbox = new MockSandbox("sess-byok-server-error", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    let threw = false;
    try {
      await kit.run({ prompt: "test", timeoutMs: 10_000 });
    } catch (error) {
      threw = true;
      assert(
        error instanceof Error &&
          error.message.includes("Provider runtime token request failed (503)"),
        "runtime-token server error is surfaced",
      );
    }
    assertEqual(threw, true, "server error fails closed");
    assertEqual(
      provider.createCalls,
      0,
      "sandbox is not created after runtime-token server error",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testProviderRuntimeBindFailureKillsSandbox(): Promise<void> {
  console.log("\n[11] provider runtime bind failure kills created sandbox");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_token",
          bindingSecret: "evrb_binding",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      return new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  const sandbox = new MockSandbox("sess-bind-fail", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    let threw = false;
    try {
      await kit.run({ prompt: "test", timeoutMs: 10_000 });
    } catch (error) {
      threw = true;
      assert(
        error instanceof Error &&
          error.message.includes("Failed to bind provider runtime token"),
        "bind failure is surfaced",
      );
    }
    assertEqual(threw, true, "run fails when bind fails");
    assertEqual(
      provider.createCalls,
      1,
      "sandbox was created before bind failure",
    );
    assertEqual(
      sandbox.killed,
      true,
      "created sandbox is killed on bind failure",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testDirectSandboxProviderDeclaredOnBind(): Promise<void> {
  console.log(
    "\n[11b] direct (user-account) sandbox declares its provider on bind; managed-typed mocks do not",
  );
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  const bindBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_direct_token",
          bindingSecret: "evrb_direct_binding",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      bindBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-direct-bind", commands);
  // A user's own-account provider: not marked Evolve-managed, with a real
  // provider type — exactly what resolveDefaultSandbox() builds from
  // E2B_API_KEY in gateway mode.
  const provider = new MockProvider(sandbox);
  (provider as { providerType: string }).providerType = "e2b";
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    await kit.executeCommand("echo ok", { timeoutMs: 10_000 });
    assert(bindBodies.length >= 1, "bind was called");
    assertEqual(
      bindBodies[0]?.directSandboxProvider,
      "e2b",
      "bind declares the direct sandbox provider",
    );
    assertEqual(
      bindBodies[0]?.sandboxId,
      "sess-direct-bind",
      "bind names the created sandbox",
    );
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }

  // An unknown provider type (this mock's own "mock") stays undeclared: the
  // platform's direct lane only knows e2b/daytona/modal, and a garbage
  // declaration would be refused typed rather than bound.
  const previousFetch2 = globalThis.fetch;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  const bindBodies2: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_direct_token2",
          bindingSecret: "evrb_direct_binding2",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      bindBodies2.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands2 = new MockCommands();
  commands2.mode = "instant";
  const sandbox2 = new MockSandbox("sess-unknown-type", commands2);
  const kit2 = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(new MockProvider(sandbox2));

  try {
    await kit2.executeCommand("echo ok", { timeoutMs: 10_000 });
    assert(bindBodies2.length >= 1, "bind was called for unknown type");
    assert(
      !("directSandboxProvider" in (bindBodies2[0] ?? {})),
      "unknown provider type sends no direct declaration",
    );
  } finally {
    await kit2.kill().catch(() => {});
    globalThis.fetch = previousFetch2;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testProviderRuntimeTokenDoesNotRefreshAndAddsCommandBindingEnv(): Promise<void> {
  console.log(
    "\n[12] provider runtime token is session-bound and command env includes binding",
  );
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  let refreshCalls = 0;
  let bindCalls = 0;
  const ingestBodies: Array<{ events?: unknown[] }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_session_token",
          bindingSecret: "evrb_session_binding",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      const body = JSON.parse(String(init.body));
      if (body.action === "refresh") {
        refreshCalls++;
        return new Response(JSON.stringify({ error: "refresh disabled" }), {
          status: 410,
          headers: { "content-type": "application/json" },
        });
      }
      bindCalls++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      ingestBodies.push(JSON.parse(String(init?.body || "{}")));
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-refresh", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    await kit.executeCommand("echo ok", { timeoutMs: 10_000 });
    const envs = commands.spawnOptions[0]?.envs || {};
    assertEqual(bindCalls, 1, "runtime token is bound once to the sandbox");
    assertEqual(
      refreshCalls,
      0,
      "session-bound runtime token is not refreshed",
    );
    assertEqual(
      envs.ANTHROPIC_API_KEY,
      "evrt_session_token",
      "command env uses provider runtime token",
    );
    assert(
      String(envs.ANTHROPIC_CUSTOM_HEADERS || "").includes(
        "x-evolve-provider-runtime-binding: evrb_session_binding",
      ),
      "command env includes provider runtime binding header",
    );
    assert(
      !("EVOLVE_API_KEY" in envs),
      "command env does not reintroduce Evolve API key",
    );
    assert(
      ingestBodies.some((body) =>
        (body.events ?? []).some(
          (event) =>
            Boolean(event) && typeof event === "object" && "_prompt" in event,
        ),
      ),
      "BYOK executeCommand creates a Dashboard session row before command start",
    );
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testProviderRuntimeTokenStaysBoundToSandbox(): Promise<void> {
  console.log(
    "\n[13] provider runtime token stays bound to the sandbox",
  );
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  let createCalls = 0;
  let refreshCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      createCalls++;
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: `evrt_session_token_${createCalls}`,
          bindingSecret: `evrb_session_binding_${createCalls}`,
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      const body = JSON.parse(String(init.body));
      if (body.action === "refresh") refreshCalls++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-rotate", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    await kit.executeCommand("echo first", { timeoutMs: 10_000 });
    await kit.executeCommand("echo second", { timeoutMs: 10_000 });

    const firstEnvs = commands.spawnOptions[0]?.envs || {};
    const secondEnvs = commands.spawnOptions[1]?.envs || {};
    assertEqual(createCalls, 1, "BYOK sandbox mints one runtime token");
    assertEqual(refreshCalls, 0, "sandbox-bound token is not refreshed");
    assertEqual(
      firstEnvs.ANTHROPIC_API_KEY,
      "evrt_session_token_1",
      "first command uses first token",
    );
    assertEqual(
      secondEnvs.ANTHROPIC_API_KEY,
      "evrt_session_token_1",
      "second command reuses sandbox-bound token",
    );
    assert(
      String(secondEnvs.ANTHROPIC_CUSTOM_HEADERS || "").includes(
        "x-evolve-provider-runtime-binding: evrb_session_binding_1",
      ),
      "second command reuses sandbox-bound binding secret",
    );
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testSetSessionRevokesProviderRuntimeToken(): Promise<void> {
  console.log("\n[14] setSession() revokes provider runtime token");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  const deletedTokens: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "anthropic",
          credentialMode: "evolve_key",
          token: "evrt_session_token",
          bindingSecret: "evrb_session_binding",
          baseUrl: "https://dashboard.test/api/model-proxy/anthropic",
          expiresAt: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      const body = JSON.parse(String(init.body));
      deletedTokens.push(String(body.token));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-switch", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    await kit.executeCommand("echo before-switch", { timeoutMs: 10_000 });
    await kit.setSession("sess-other");
    assert(
      deletedTokens.includes("evrt_session_token"),
      "setSession() deletes cached provider runtime token",
    );
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testCodexProviderRuntimeRoutesThroughDashboardProxy(): Promise<void> {
  console.log("\n[15] Codex OpenAI BYOK routes through Dashboard proxy");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  const createBodies: Array<{ provider?: string; sessionTag?: string }> = [];
  const deletedTokens: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      createBodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "openai",
          credentialMode: "evolve_key",
          token: "evrt_openai_session_token",
          bindingSecret: "evrb_openai_session_binding",
          baseUrl: "https://dashboard.test/api/model-proxy/openai/v1",
          expiresAt: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      const body = JSON.parse(String(init.body));
      deletedTokens.push(String(body.token));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-codex-byok", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "codex", apiKey: "evolve-key" })
    .withSandbox(provider);

  try {
    await kit.run({ prompt: "hello", timeoutMs: 10_000 });

    assertEqual(createBodies[0]?.provider, "openai", "runtime token request uses openai provider");
    assertEqual(provider.createOptions?.envs?.OPENAI_API_KEY, "evrt_openai_session_token", "sandbox env uses OpenAI runtime token");
    assertEqual(provider.createOptions?.envs?.OPENAI_BASE_URL, "https://dashboard.test/api/model-proxy/openai/v1", "sandbox env uses Dashboard OpenAI proxy");
    assert(!provider.createOptions?.envs?.EVOLVE_API_KEY, "sandbox env does not expose Evolve API key");
    assertEqual(provider.createOptions?.envs?.EVOLVE_PROVIDER_RUNTIME_BINDING, "evrb_openai_session_binding", "sandbox env includes binding secret env");

    const codexConfig = sandbox.files.writes.get("/home/user/.codex/config.toml") || "";
    assert(codexConfig.includes('base_url = "https://dashboard.test/api/model-proxy/openai/v1"'), "Codex TOML uses Dashboard proxy base URL");
    assert(codexConfig.includes("x-evolve-provider-runtime-binding"), "Codex TOML maps provider runtime binding header");
    assert(codexConfig.includes("EVOLVE_PROVIDER_RUNTIME_BINDING"), "Codex TOML reads binding header from env");

    const runEnvs = commands.spawnOptions[0]?.envs || {};
    assertEqual(runEnvs.OPENAI_API_KEY, "evrt_openai_session_token", "run env uses OpenAI runtime token");
    assertEqual(runEnvs.OPENAI_BASE_URL, "https://dashboard.test/api/model-proxy/openai/v1", "run env uses Dashboard OpenAI proxy");
    assertEqual(runEnvs.EVOLVE_PROVIDER_RUNTIME_BINDING, "evrb_openai_session_binding", "run env includes binding secret");

    await kit.kill();
    assert(
      deletedTokens.includes("evrt_openai_session_token"),
      "kill() revokes OpenAI provider runtime token",
    );
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testCodexConnectedSessionReassertsDashboardProxy(): Promise<void> {
  console.log("\n[16] Codex withSession reasserts Dashboard proxy config");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  const createBodies: Array<{ provider?: string; sessionTag?: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      createBodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          enabled: true,
          provider: "openai",
          credentialMode: "evolve_key",
          token: "evrt_openai_existing_session",
          bindingSecret: "evrb_openai_existing_session",
          baseUrl: "https://dashboard.test/api/model-proxy/openai/v1",
          expiresAt: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  commands.mode = "instant";
  const sandbox = new MockSandbox("sess-codex-existing", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "codex", apiKey: "evolve-key" })
    .withSandbox(provider)
    .withSession("sess-codex-existing");

  try {
    await kit.run({ prompt: "hello", timeoutMs: 10_000 });

    assertEqual(provider.connectCalls, 1, "existing sandbox is connected");
    assertEqual(provider.createCalls, 0, "existing sandbox is not recreated");
    assertEqual(createBodies[0]?.provider, "openai", "runtime token request uses openai provider");

    const codexConfig = sandbox.files.writes.get("/home/user/.codex/config.toml") || "";
    assert(codexConfig.includes('base_url = "https://dashboard.test/api/model-proxy/openai/v1"'), "connected Codex session writes Dashboard proxy base URL");
    assert(codexConfig.includes("x-evolve-provider-runtime-binding"), "connected Codex session maps provider runtime binding header");
    assert(codexConfig.includes("EVOLVE_PROVIDER_RUNTIME_BINDING"), "connected Codex session reads binding header from env");

    const runEnvs = commands.spawnOptions[0]?.envs || {};
    assertEqual(runEnvs.OPENAI_API_KEY, "evrt_openai_existing_session", "connected Codex run env uses runtime token");
    assertEqual(runEnvs.OPENAI_BASE_URL, "https://dashboard.test/api/model-proxy/openai/v1", "connected Codex run env uses Dashboard proxy");
    assertEqual(runEnvs.EVOLVE_PROVIDER_RUNTIME_BINDING, "evrb_openai_existing_session", "connected Codex run env includes binding secret");
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testManagedGatewayAgentsUseRuntimeProxyLifecycle(): Promise<void> {
  console.log("\n[17] all managed gateway agents use runtime proxy lifecycle");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";

  const createBodies: Array<{ provider?: RuntimeProvider; sessionTag?: string }> = [];
  const bindBodies: Array<{ token?: string; sandboxId?: string }> = [];
  const deletedTokens: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        provider?: RuntimeProvider;
        sessionTag?: string;
      };
      if (!body.provider) throw new Error("missing provider");
      createBodies.push(body);
      return new Response(JSON.stringify(runtimeTokenResponse(body.provider)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      bindBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      const body = JSON.parse(String(init.body));
      deletedTokens.push(String(body.token));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const cases: Array<{
    agentType: string;
    provider: RuntimeProvider;
    tokenMustBeInSandboxConfig: boolean;
    /**
     * Whether the SDK can hand the CLI the runtime BINDING secret (the door's
     * second, header-borne secret). Every CLI with a custom-header or
     * config-file channel carries it; the antigravity CLI has neither (no
     * header reaches its requests — four candidates probed live 2026-09-25),
     * so the door exempts that one provider from the binding requirement,
     * as it already does for every trial box (verify.ts header), and the SDK
     * deliberately delivers nothing.
     */
    carriesBinding: boolean;
  }> = [
    { agentType: "claude", provider: "anthropic", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "codex", provider: "openai", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "gemini", provider: "gemini", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "qwen", provider: "dashscope", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "kimi", provider: "kimi", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "opencode", provider: "openrouter", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "droid", provider: "droid", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "pi", provider: "pi", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "prime-agent", provider: "prime-agent", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "dsh", provider: "dsh", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    // zcode reads its key from the per-run provider file, written into the
    // sandbox (the writes are part of sandboxConfig below), never from env.
    { agentType: "zcode", provider: "zcode", tokenMustBeInSandboxConfig: true, carriesBinding: true },
    { agentType: "antigravity", provider: "antigravity", tokenMustBeInSandboxConfig: true, carriesBinding: false },
  ];

  try {
    for (const item of cases) {
      const startCreate = createBodies.length;
      const startBind = bindBodies.length;
      const commands = new MockCommands();
      commands.mode = "instant";
      const sandbox = new MockSandbox(`sess-managed-${item.agentType}`, commands);
      const provider = new MockProvider(sandbox);
      const kit = new Evolve()
        .withAgent({ type: item.agentType, apiKey: "evolve-key" } as any)
        .withSandbox(provider);

      await kit.run({ prompt: "managed proxy lifecycle probe", timeoutMs: 10_000 });
      await kit.kill();

      const createBody = createBodies[startCreate];
      const bindBody = bindBodies[startBind];
      const envs = provider.createOptions?.envs ?? {};
      const sandboxConfig = JSON.stringify({
        envs,
        runEnvs: commands.spawnOptions[0]?.envs ?? {},
        writes: Object.fromEntries(sandbox.files.writes),
      });
      const expectedToken = `evrt_${item.provider}`;
      const expectedBinding = `evrb_${item.provider}`;

      assertEqual(
        createBody?.provider,
        item.provider,
        `${item.agentType} requests ${item.provider} runtime token`,
      );
      assertEqual(
        bindBody?.sandboxId,
        sandbox.sandboxId,
        `${item.agentType} binds runtime token to sandbox`,
      );
      assertEqual(
        bindBody?.token,
        expectedToken,
        `${item.agentType} binds the minted runtime token`,
      );
      assert(
        deletedTokens.includes(expectedToken),
        `${item.agentType} kill() revokes runtime token`,
      );
      assert(
        !Object.prototype.hasOwnProperty.call(envs, "EVOLVE_API_KEY"),
        `${item.agentType} sandbox env omits EVOLVE_API_KEY`,
      );
      assert(
        !sandboxConfig.includes("evolve-key"),
        `${item.agentType} sandbox config does not contain raw Evolve API key`,
      );
      assert(
        sandboxConfig.includes(expectedBinding) === item.carriesBinding,
        item.carriesBinding
          ? `${item.agentType} sandbox config includes runtime binding secret`
          : `${item.agentType} sandbox config carries NO binding secret — the CLI has no header channel for it`,
      );
      if (item.tokenMustBeInSandboxConfig) {
        assert(
          sandboxConfig.includes(expectedToken),
          `${item.agentType} sandbox config uses provider runtime token`,
        );
      }
      assert(
        sandboxConfig.includes(`/api/model-proxy/${item.provider}`),
        `${item.agentType} sandbox config routes through Dashboard model proxy`,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined)
      delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

async function testTaskWorkspaceAndSandboxCreateOptions(): Promise<void> {
  console.log("\n[17] task workspace + sandbox create options");
  const commands = new MockCommands();
  const sandbox = new MockSandbox("task-create", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "provider-key" })
    .withSandbox(provider)
    .withSandboxCreateOptions({
      image: "prepared-task-v1",
      envs: { TASK_FLAG: "enabled" },
      metadata: { job: "job-1" },
      timeoutMs: 45_000,
      workingDirectory: "/task",
    })
    .withWorkspaceMode("task");

  try {
    await kit.executeCommand("true", { timeoutMs: 1_000 });
    assertEqual(provider.createOptions?.image, "prepared-task-v1", "image is forwarded");
    assertEqual(provider.createOptions?.timeoutMs, 45_000, "timeout is forwarded");
    assertEqual(
      provider.createOptions?.metadata?.job,
      "job-1",
      "metadata is forwarded",
    );
    assertEqual(
      provider.createOptions?.workingDirectory,
      "/task",
      "provider and command use the task working directory",
    );
    assertEqual(
      provider.createOptions?.envs?.TASK_FLAG,
      "enabled",
      "caller env is forwarded",
    );
    assert(
      !commands.runCommands.some((command) => command.includes("mkdir -p /task")),
      "task mode does not generate workspace directories",
    );
    assertEqual(sandbox.files.writes.size, 0, "task mode writes no prompt or workspace files");
  } finally {
    await kit.kill().catch(() => {});
  }

  const invalidProvider = new MockProvider(
    new MockSandbox("task-invalid", new MockCommands()),
  );
  let invalidThrew = false;
  try {
    await new Evolve()
      .withAgent({ type: "claude", providerApiKey: "provider-key" })
      .withSandbox(invalidProvider)
      .withWorkspaceMode("task")
      .withSystemPrompt("generated prompt")
      .executeCommand("true");
  } catch (error) {
    invalidThrew = String(error).includes("task owns the working directory");
  }
  assert(invalidThrew, "task mode rejects generated workspace inputs");
  assertEqual(invalidProvider.createCalls, 0, "invalid task mode fails before sandbox creation");
}

async function testCredentialSealAndArtifactCollection(): Promise<void> {
  console.log("\n[18] credential seal + artifact collection");
  const previousFetch = globalThis.fetch;
  const previousDashboardUrl = process.env.EVOLVE_DASHBOARD_URL;
  process.env.EVOLVE_DASHBOARD_URL = "https://dashboard.test";
  let revokeCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "POST"
    ) {
      return new Response(JSON.stringify(runtimeTokenResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "PATCH"
    ) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (
      url === "https://dashboard.test/api/provider-secrets/runtime-token" &&
      init?.method === "DELETE"
    ) {
      revokeCalls++;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://dashboard.test/api/sessions/ingest") {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  const sandbox = new MockSandbox("sealed-task", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "evolve-key" })
    .withSandbox(provider)
    .withWorkspaceMode("task")
    .withWorkingDirectory("/task");

  try {
    await kit.run({ prompt: "solve the task", timeoutMs: 10_000 });
    await sandbox.files.write("/task/patch.diff", "diff --git a/a b/a");
    await sandbox.files.write("/logs/artifacts/model.patch", "absolute patch");
    commands.runHandler = (command) => ({
      exitCode: 0,
      stdout: isArtifactListing(command)
        ? artifactListingStdout("/logs/artifacts/model.patch\0" + "14\0/task/patch.diff\0" + "21\0")
        : "",
      stderr: "",
    });

    await kit.sealCredentials();
    assertEqual(revokeCalls, 1, "seal revokes the task runtime token exactly once");

    const artifacts = await kit.collectArtifacts(["patch.diff", "/logs/artifacts/model.patch"]);
    assertEqual(
      artifacts["patch.diff"] as string,
      "diff --git a/a b/a",
      "sealed artifact collection returns declared files",
    );
    assertEqual(
      artifacts["/logs/artifacts/model.patch"] as string,
      "absolute patch",
      "sealed artifact collection preserves declared absolute paths",
    );

    await kit.executeCommand("python verifier.py", { timeoutMs: 10_000 });
    const verifierEnvs = commands.spawnOptions[1]?.envs;
    assert(
      !verifierEnvs || Object.keys(verifierEnvs).length === 0,
      "post-seal command receives no model credential env",
    );

    let rerunThrew = false;
    try {
      await kit.run({ prompt: "run again" });
    } catch (error) {
      rerunThrew = String(error).includes("credentials are sealed");
    }
    assert(rerunThrew, "seal irreversibly disables future agent runs");

    let escapeThrew = false;
    try {
      await kit.collectArtifacts(["../secret"]);
    } catch (error) {
      escapeThrew = String(error).includes("escapes the working directory");
    }
    assert(escapeThrew, "artifact collection rejects path traversal");

    commands.runHandler = (command) => ({
      exitCode: 0,
      stdout: isArtifactListing(command)
        ? artifactListingStdout(`/task/patch.diff\0${100 * 1024 * 1024 + 1}\0`)
        : "",
      stderr: "",
    });
    // No ceiling of the SDK's own on a file's size (2026-09-14): a listing past
    // the former 100 MiB figure is collected like any other; only the runtime's
    // own limits can refuse it, and a refusal is never the old "Artifact exceeds".
    let oversizedRefusedByTheOldCap = false;
    let oversizedCollected = false;
    try {
      const collected = await kit.collectArtifacts(["patch.diff"]);
      oversizedCollected = "patch.diff" in collected;
    } catch (error) {
      oversizedRefusedByTheOldCap = String(error).includes("Artifact exceeds");
    }
    assert(!oversizedRefusedByTheOldCap, "artifact collection no longer refuses a file for its listed size");
    assert(oversizedCollected, "a file listed past the former 100 MiB figure is collected");

    assert(kit.isSealed(), "isSealed() reports true after sealing");

    // Missing/unreadable declared roots are infrastructure failures, never a
    // silent empty result (a fake "agent produced nothing").
    commands.runHandler = (command) => ({
      exitCode: 0,
      stdout: command.includes("MISSING") ? "MISSING '/task/gone'\n" : "",
      stderr: "",
    });
    let missingRootThrew = false;
    try {
      await kit.collectArtifacts(["gone"]);
    } catch (error) {
      missingRootThrew = String(error).includes("not collectable");
    }
    assert(missingRootThrew, "artifact collection fails loudly on a missing declared root");

    // A failing find (permissions, non-GNU find) surfaces instead of returning empty.
    // `pipefail` keeps the nonzero exit visible even though base64 is the pipe tail.
    commands.runHandler = (command) => ({
      exitCode: isArtifactListing(command) ? 1 : 0,
      stdout: "",
      stderr: isArtifactListing(command) ? "find: permission denied" : "",
    });
    let listingThrew = false;
    try {
      await kit.collectArtifacts(["patch.diff"]);
    } catch (error) {
      listingThrew = String(error).includes("Artifact listing failed");
    }
    assert(listingThrew, "artifact listing failure surfaces instead of silent empty map");

    // Sealing without an active runtime token must throw, never fake success.
    const commands2 = new MockCommands();
    const sandbox2 = new MockSandbox("sealed-task-2", commands2);
    const provider2 = new MockProvider(sandbox2);
    const kit2 = new Evolve()
      .withAgent({ type: "claude", apiKey: "evolve-key" })
      .withSandbox(provider2)
      .withWorkspaceMode("task")
      .withWorkingDirectory("/task");
    try {
      await kit2.run({ prompt: "solve", timeoutMs: 10_000 });
      assert(!kit2.isSealed(), "isSealed() reports false before sealing");
      (kit2 as any).agent.providerRuntimeToken = undefined;
      let tokenlessThrew = false;
      try {
        await kit2.sealCredentials();
      } catch (error) {
        tokenlessThrew = String(error).includes("no active provider runtime token");
      }
      assert(tokenlessThrew, "seal without an active runtime token throws instead of faking success");
      assert(!kit2.isSealed(), "failed seal never reports sealed");
    } finally {
      await kit2.kill().catch(() => {});
    }
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousDashboardUrl === undefined) delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = previousDashboardUrl;
  }
}

interface RecordedE2bCall {
  method: string;
  command?: string;
  path?: string;
  opts?: Record<string, unknown>;
}

/**
 * Fake of the raw E2B SDK sandbox surface. Wrapped by the REAL E2BCommands /
 * E2BFiles adapters so tests verify the actual user-threading code path.
 */
function createFakeE2bSandbox() {
  const calls: RecordedE2bCall[] = [];
  const files = new Map<string, string>();
  let runHandler:
    | ((command: string) => SandboxCommandResult)
    | undefined;

  const fake = {
    sandboxId: "e2b-fake",
    commands: {
      run: async (command: string, opts?: Record<string, unknown>) => {
        calls.push({
          method: opts?.background ? "spawn" : "run",
          command,
          opts,
        });
        const result = runHandler?.(command) ?? {
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
        if (opts?.background) {
          return {
            pid: calls.length,
            wait: async () => result,
            kill: async () => true,
          };
        }
        return result;
      },
      kill: async () => true,
    },
    files: {
      read: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ method: "read", path, opts });
        const value = files.get(path);
        if (value === undefined) throw new Error(`not found: ${path}`);
        return value;
      },
      write: async (
        pathOrEntries: string | Array<{ path: string; data: unknown }>,
        dataOrOpts?: unknown,
        maybeOpts?: unknown,
      ) => {
        if (typeof pathOrEntries === "string") {
          calls.push({
            method: "write",
            path: pathOrEntries,
            opts: maybeOpts as Record<string, unknown>,
          });
          files.set(pathOrEntries, String(dataOrOpts));
          return;
        }
        calls.push({
          method: "writeBatch",
          opts: dataOrOpts as Record<string, unknown>,
        });
        for (const entry of pathOrEntries) {
          files.set(entry.path, String(entry.data));
        }
      },
      makeDir: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ method: "makeDir", path, opts });
        return true;
      },
      exists: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ method: "exists", path, opts });
        return files.has(path);
      },
      list: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ method: "list", path, opts });
        return [];
      },
      remove: async (path: string, opts?: Record<string, unknown>) => {
        calls.push({ method: "remove", path, opts });
        files.delete(path);
      },
      rename: async (
        oldPath: string,
        newPath: string,
        opts?: Record<string, unknown>,
      ) => {
        calls.push({ method: "rename", path: oldPath, opts });
        return { name: newPath, path: newPath, type: "file" };
      },
      watchDir: async (
        path: string,
        _onEvent: unknown,
        opts?: Record<string, unknown>,
      ) => {
        calls.push({ method: "watchDir", path, opts });
        return { stop: async () => {} };
      },
    },
  };

  return {
    fake,
    calls,
    files,
    setRunHandler: (handler: (command: string) => SandboxCommandResult) => {
      runHandler = handler;
    },
  };
}

/** Provider composing the REAL E2B command/file adapters over the fake SDK. */
class FakeE2BUserProvider implements SandboxProvider {
  readonly providerType = "e2b";
  readonly name = "e2b-fake";
  public createOptions?: SandboxCreateOptions;

  constructor(private readonly fakeSandbox: ReturnType<typeof createFakeE2bSandbox>["fake"]) {}

  async create(options: SandboxCreateOptions): Promise<SandboxInstance> {
    this.createOptions = options;
    // Mirrors E2BProvider.create(): workingDirectory makeDir runs as the user.
    if (options.workingDirectory) {
      await this.fakeSandbox.files.makeDir(options.workingDirectory, {
        user: options.user,
      });
    }
    return {
      sandboxId: this.fakeSandbox.sandboxId,
      commands: new E2BCommands(this.fakeSandbox as any, options.user),
      files: new E2BFiles(this.fakeSandbox as any, options.user),
      getHost: async (port: number) => `http://localhost:${port}`,
      kill: async () => {},
      pause: async () => {},
    };
  }

  async connect(): Promise<SandboxInstance> {
    throw new Error("connect not supported in FakeE2BUserProvider");
  }
}

async function testRootUserThreadedThroughE2bOperations(): Promise<void> {
  console.log(
    "\n[19] sandbox user threaded through every e2b operation (root homeDir)",
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch in externalGateway mode: ${String(input)}`);
  }) as typeof fetch;

  const { fake, calls, files, setRunHandler } = createFakeE2bSandbox();
  const provider = new FakeE2BUserProvider(fake);
  let revokeCalls = 0;

  const kit = new Evolve()
    .withAgent({
      type: "codex",
      externalGateway: {
        apiKey: "sk-litellm-task",
        baseUrl: "https://litellm.test/v1",
        revoke: async () => {
          revokeCalls++;
        },
      },
    })
    .withSandbox(provider)
    .withSandboxCreateOptions({ image: "task-image-v1", user: "root" })
    .withWorkspaceMode("task")
    .withWorkingDirectory("/task");

  try {
    const result = await kit.run({ prompt: "solve the task", timeoutMs: 10_000 });
    assertEqual(result.exitCode, 0, "externalGateway run succeeds as root user");
    assertEqual(
      provider.createOptions?.user,
      "root",
      "sandbox create options carry the configured user",
    );
    const createEnvs = provider.createOptions?.envs ?? {};
    assertEqual(
      createEnvs.OPENAI_API_KEY,
      "sk-litellm-task",
      "create env injects external gateway key like direct mode",
    );
    assertEqual(
      createEnvs.OPENAI_BASE_URL,
      "https://litellm.test/v1",
      "create env injects external gateway base URL",
    );
    assert(
      !("EVOLVE_API_KEY" in createEnvs),
      "externalGateway mode does not require or expose EVOLVE_API_KEY",
    );

    const codexToml = files.get("/root/.codex/config.toml") || "";
    assert(
      codexToml.includes('base_url = "https://litellm.test/v1"'),
      "root homeDir: codex config lands at /root/.codex/config.toml with external base_url",
    );
    assert(
      codexToml.includes('wire_api = "responses"'),
      "external codex provider keeps wire_api pinned to responses",
    );
    assert(
      !codexToml.includes("env_http_headers"),
      "external codex provider omits litellm/binding env_http_headers",
    );

    const runSpawn = calls.find((call) => call.method === "spawn");
    const runSpawnEnvs = (runSpawn?.opts?.envs ?? {}) as Record<string, string>;
    assertEqual(
      runSpawnEnvs.OPENAI_API_KEY,
      "sk-litellm-task",
      "per-spawn env re-injects external gateway key",
    );

    await kit.sealCredentials();
    assertEqual(revokeCalls, 1, "sealCredentials calls external revoke exactly once");
    await kit.sealCredentials();
    assertEqual(revokeCalls, 1, "second seal is a no-op and does not re-revoke");

    files.set("/task/patch.diff", "diff-data");
    setRunHandler((command) => {
      if (isArtifactListing(command)) {
        return {
          exitCode: 0,
          stdout: artifactListingStdout("/task/patch.diff\0" + "9\0"),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const artifacts = await kit.collectArtifacts(["patch.diff"]);
    assertEqual(
      artifacts["patch.diff"] as string,
      "diff-data",
      "collectArtifacts works post-seal in externalGateway mode",
    );

    const artifactFind = calls.find(
      (call) => call.method === "run" && !!call.command && isArtifactListing(call.command),
    );
    assertEqual(
      artifactFind?.opts?.user,
      "root",
      "artifact find runs as the configured user",
    );
    const artifactRead = calls.find(
      (call) => call.method === "read" && call.path === "/task/patch.diff",
    );
    assertEqual(
      artifactRead?.opts?.user,
      "root",
      "artifact file read runs as the configured user",
    );

    const optBearing = calls.filter((call) =>
      ["run", "spawn", "read", "write", "writeBatch", "makeDir", "exists", "list", "remove", "rename", "watchDir"].includes(
        call.method,
      ),
    );
    assert(optBearing.length > 0, "e2b operations were recorded");
    const missingUser = optBearing.filter((call) => call.opts?.user !== "root");
    assertEqual(
      missingUser.length,
      0,
      `every e2b command/file operation carries user=root${
        missingUser.length
          ? ` (missing on: ${missingUser.map((c) => c.method).join(", ")})`
          : ""
      }`,
    );
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
  }
}

async function testExternalGatewaySealFlow(): Promise<void> {
  console.log("\n[20] externalGateway seal + post-seal command/collect flow");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch in externalGateway mode: ${String(input)}`);
  }) as typeof fetch;

  const commands = new MockCommands();
  const sandbox = new MockSandbox("external-seal", commands);
  const provider = new MockProvider(sandbox);
  let revokeCalls = 0;
  let revokeShouldFail = true;

  const kit = new Evolve()
    .withAgent({
      type: "codex",
      externalGateway: {
        apiKey: "sk-litellm-task",
        baseUrl: "https://litellm.test/v1",
        revoke: async () => {
          revokeCalls++;
          if (revokeShouldFail) throw new Error("revocation endpoint down");
        },
      },
    })
    .withSandbox(provider)
    .withWorkspaceMode("task")
    .withWorkingDirectory("/task");

  try {
    await kit.run({ prompt: "solve", timeoutMs: 10_000 });
    const codexToml =
      sandbox.files.writes.get("/home/user/.codex/config.toml") || "";
    assert(
      codexToml.includes('base_url = "https://litellm.test/v1"'),
      "run works with the custom base_url in the codex toml",
    );

    let sealThrew = false;
    try {
      await kit.sealCredentials();
    } catch (error) {
      sealThrew = String(error).includes("revocation endpoint down");
    }
    assert(sealThrew, "failed revoke propagates out of sealCredentials");
    assertEqual(revokeCalls, 1, "failed seal attempted revoke once");
    assert(!kit.isSealed(), "failed revoke never marks credentials sealed");

    revokeShouldFail = false;
    await kit.sealCredentials();
    assertEqual(revokeCalls, 2, "successful seal calls revoke exactly once more");
    assert(kit.isSealed(), "seal reports sealed after successful revoke");

    await kit.executeCommand("python verifier.py", { timeoutMs: 10_000 });
    const postSealEnvs =
      commands.spawnOptions[commands.spawnOptions.length - 1]?.envs;
    assert(
      !postSealEnvs || !("OPENAI_API_KEY" in postSealEnvs),
      "post-seal executeCommand injects no OPENAI_API_KEY",
    );
    assert(
      !postSealEnvs || Object.keys(postSealEnvs).length === 0,
      "post-seal executeCommand injects no credential envs at all",
    );

    await sandbox.files.write("/task/patch.diff", "diff --git a/a b/a");
    commands.runHandler = (command) => ({
      exitCode: 0,
      stdout: isArtifactListing(command)
        ? artifactListingStdout("/task/patch.diff\0" + "18\0")
        : "",
      stderr: "",
    });
    const artifacts = await kit.collectArtifacts(["patch.diff"]);
    assertEqual(
      artifacts["patch.diff"] as string,
      "diff --git a/a b/a",
      "collectArtifacts remains seal-gated and functional",
    );

    let rerunThrew = false;
    try {
      await kit.run({ prompt: "again" });
    } catch (error) {
      rerunThrew = String(error).includes("credentials are sealed");
    }
    assert(rerunThrew, "run() throws after external seal");
  } finally {
    await kit.kill().catch(() => {});
    globalThis.fetch = previousFetch;
  }
}

async function testExternalGatewayMutualExclusivity(): Promise<void> {
  console.log("\n[21] externalGateway mutual exclusivity + direct-mode seal refusal");

  const externalGateway = {
    apiKey: "sk-litellm-task",
    baseUrl: "https://litellm.test/v1",
    revoke: async () => {},
  };

  const conflicts: Array<{ label: string; config: Record<string, unknown> }> = [
    {
      label: "providerApiKey",
      config: { type: "codex", externalGateway, providerApiKey: "sk-direct" },
    },
    {
      label: "providerBaseUrl",
      config: {
        type: "codex",
        externalGateway,
        providerBaseUrl: "https://direct.test",
      },
    },
    {
      label: "apiKey (gateway mode)",
      config: { type: "codex", externalGateway, apiKey: "evolve-key" },
    },
    {
      label: "oauthToken",
      config: { type: "claude", externalGateway, oauthToken: "oauth-token" },
    },
  ];

  for (const item of conflicts) {
    let threw = false;
    try {
      new Evolve().withAgent(item.config as any);
    } catch (error) {
      threw = String(error).includes("externalGateway cannot be combined");
    }
    assert(threw, `withAgent throws at config time for externalGateway + ${item.label}`);
  }

  // Plain direct mode must STILL refuse to seal.
  const commands = new MockCommands();
  const sandbox = new MockSandbox("direct-seal", commands);
  const provider = new MockProvider(sandbox);
  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "sk-direct" })
    .withSandbox(provider)
    .withWorkspaceMode("task")
    .withWorkingDirectory("/task");

  try {
    await kit.run({ prompt: "solve", timeoutMs: 10_000 });
    let threw = false;
    try {
      await kit.sealCredentials();
    } catch (error) {
      threw = String(error).includes("requires gateway mode");
    }
    assert(threw, "plain direct mode (no revoke) still refuses sealCredentials");
    assert(!kit.isSealed(), "refused direct-mode seal never reports sealed");
  } finally {
    await kit.kill().catch(() => {});
  }
}

async function testExternalGatewayPerHarnessWiring(): Promise<void> {
  console.log("\n[22] externalGateway wiring per harness (gemini/qwen/kimi/opencode/droid/pi/prime-agent/dsh/zcode/antigravity)");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch in externalGateway mode: ${String(input)}`);
  }) as typeof fetch;

  const EXTERNAL_KEY = "sk-litellm-task";
  const EXTERNAL_URL = "https://litellm.test/route";

  async function runHarness(type: string, model: string) {
    const commands = new MockCommands();
    const sandbox = new MockSandbox(`external-${type}`, commands);
    const provider = new MockProvider(sandbox);
    const kit = new Evolve()
      .withAgent({
        type: type as never,
        model,
        externalGateway: {
          apiKey: EXTERNAL_KEY,
          baseUrl: EXTERNAL_URL,
          revoke: async () => {},
        },
      })
      .withSandbox(provider)
      .withWorkspaceMode("task")
      .withWorkingDirectory("/task");
    try {
      await kit.run({ prompt: "solve", timeoutMs: 10_000 });
    } finally {
      await kit.kill().catch(() => {});
    }
    return {
      bootEnvs: (provider.createOptions?.envs ?? {}) as Record<string, string>,
      spawnEnvs: (commands.spawnOptions[0]?.envs ?? {}) as Record<string, string>,
      command: commands.spawned[0] ?? "",
      files: sandbox.files.writes,
    };
  }

  try {
    // gemini: direct-style env wiring on the Gemini-native base URL env.
    const gemini = await runHarness("gemini", "gw-gemini-model");
    assertEqual(gemini.bootEnvs.GEMINI_API_KEY, EXTERNAL_KEY, "gemini boot env injects GEMINI_API_KEY");
    assertEqual(gemini.bootEnvs.GOOGLE_GEMINI_BASE_URL, EXTERNAL_URL, "gemini boot env injects GOOGLE_GEMINI_BASE_URL");
    assertEqual(gemini.spawnEnvs.GEMINI_API_KEY, EXTERNAL_KEY, "gemini spawn env re-injects GEMINI_API_KEY");
    assertEqual(gemini.spawnEnvs.GOOGLE_GEMINI_BASE_URL, EXTERNAL_URL, "gemini spawn env re-injects GOOGLE_GEMINI_BASE_URL");
    assert(gemini.command.includes("--model gw-gemini-model"), "gemini command carries the VERBATIM caller model");
    assert(!("EVOLVE_API_KEY" in gemini.bootEnvs), "gemini externalGateway never exposes EVOLVE_API_KEY");
    // Gemini selects its auth method from ~/.gemini/settings.json (NOT an env
    // var); externalGateway resolves to isDirectMode=true, so the settings write
    // must still fire or the CLI exits 41 ("Invalid auth method selected").
    const geminiSettingsRaw = gemini.files.get("/home/user/.gemini/settings.json") ?? "";
    assert(geminiSettingsRaw.length > 0, "gemini externalGateway writes ~/.gemini/settings.json");
    const geminiSettings = JSON.parse(geminiSettingsRaw) as {
      security?: { auth?: { selectedType?: string } };
    };
    assertEqual(
      geminiSettings.security?.auth?.selectedType,
      "gemini-api-key",
      "gemini settings.json selects the gateway api-key auth method",
    );
    // Gemini 0.52+ refuses headless runs in an untrusted workspace (exit 55);
    // the sandbox workspace is trusted explicitly, on both boot and spawn envs.
    assertEqual(gemini.bootEnvs.GEMINI_CLI_TRUST_WORKSPACE, "true", "gemini boot env trusts the sandbox workspace");
    assertEqual(gemini.spawnEnvs.GEMINI_CLI_TRUST_WORKSPACE, "true", "gemini spawn env re-trusts the sandbox workspace");

    // claude: always declares sandbox mode (IS_SANDBOX) so the CLI permits
    // --dangerously-skip-permissions under root — the eval boots as root and the
    // CLI otherwise refuses ("cannot be used with root/sudo privileges") → exit 1.
    const claude = await runHarness("claude", "gw-claude-model");
    assertEqual(claude.bootEnvs.IS_SANDBOX, "1", "claude boot env declares sandbox mode for the root skip-permissions guard");
    assert(claude.command.includes("--dangerously-skip-permissions"), "claude command runs with --dangerously-skip-permissions");

    // qwen: OpenAI-convention env wiring, model verbatim (no dashscope/ rewrite).
    const qwen = await runHarness("qwen", "gw-qwen-model");
    assertEqual(qwen.bootEnvs.OPENAI_API_KEY, EXTERNAL_KEY, "qwen boot env injects OPENAI_API_KEY");
    assertEqual(qwen.bootEnvs.OPENAI_BASE_URL, EXTERNAL_URL, "qwen boot env injects OPENAI_BASE_URL");
    assertEqual(qwen.spawnEnvs.OPENAI_API_KEY, EXTERNAL_KEY, "qwen spawn env re-injects OPENAI_API_KEY");
    assert(qwen.command.includes("--model gw-qwen-model"), "qwen command carries the VERBATIM caller model (no dashscope/ prefix)");
    assert(qwen.command.includes("--auth-type openai"), "qwen command keeps --auth-type openai");

    // kimi: Kimi Code reads KIMI_MODEL_* — never KIMI_API_KEY/KIMI_BASE_URL.
    const kimi = await runHarness("kimi", "gw-kimi-model");
    assertEqual(kimi.bootEnvs.KIMI_MODEL_API_KEY, EXTERNAL_KEY, "kimi boot env injects KIMI_MODEL_API_KEY");
    assertEqual(kimi.bootEnvs.KIMI_MODEL_BASE_URL, EXTERNAL_URL, "kimi boot env injects KIMI_MODEL_BASE_URL");
    assertEqual(kimi.bootEnvs.KIMI_MODEL_NAME, "gw-kimi-model", "kimi boot env carries the VERBATIM caller model");
    assertEqual(kimi.bootEnvs.KIMI_MODEL_PROVIDER_TYPE, "kimi", "kimi boot env pins the kimi provider type");
    assertEqual(kimi.spawnEnvs.KIMI_MODEL_API_KEY, EXTERNAL_KEY, "kimi spawn env re-injects KIMI_MODEL_API_KEY");
    assertEqual(kimi.spawnEnvs.KIMI_MODEL_BASE_URL, EXTERNAL_URL, "kimi spawn env re-injects KIMI_MODEL_BASE_URL");
    assert(!("KIMI_API_KEY" in kimi.spawnEnvs), "kimi spawn env does NOT inject the unread KIMI_API_KEY");
    assert(!("KIMI_BASE_URL" in kimi.spawnEnvs), "kimi spawn env does NOT inject the unread KIMI_BASE_URL");

    // opencode: inline provider config carries credential + base URL; the
    // command routes the VERBATIM model under the litellm provider.
    const opencode = await runHarness("opencode", "gw-opencode-model");
    const configJson = opencode.spawnEnvs.OPENCODE_CONFIG_CONTENT ?? "";
    assert(configJson.length > 0, "opencode spawn env carries OPENCODE_CONFIG_CONTENT");
    const parsed = JSON.parse(configJson) as {
      provider?: { litellm?: { options?: { baseURL?: string; apiKey?: string }; models?: Record<string, { headers?: Record<string, string> }> } };
    };
    assertEqual(parsed.provider?.litellm?.options?.baseURL, EXTERNAL_URL, "opencode litellm provider points at the external base URL VERBATIM");
    assertEqual(parsed.provider?.litellm?.options?.apiKey, EXTERNAL_KEY, "opencode litellm provider carries the caller-minted key");
    const modelEntry = parsed.provider?.litellm?.models?.["gw-opencode-model"];
    assert(modelEntry !== undefined, "opencode litellm provider registers the VERBATIM caller model");
    assertEqual(
      Object.keys(modelEntry?.headers ?? {}).length,
      0,
      "opencode external config carries NO LiteLLM spend headers",
    );
    const bootConfig = opencode.bootEnvs.OPENCODE_CONFIG_CONTENT ?? "";
    assert(bootConfig.includes(EXTERNAL_URL), "opencode boot env also carries the external provider config");
    assert(opencode.command.includes("--model litellm/gw-opencode-model"), "opencode command routes litellm/<verbatim model>");
    assert(!opencode.command.includes("openrouter/"), "opencode command never rewrites the model to openrouter/");

    // droid: routed via the Evolve-owned settings file at the external base
    // URL verbatim, env-referenced key, no LiteLLM headers, custom model id.
    const droid = await runHarness("droid", "gw-droid-model");
    const settingsRaw = droid.files.get("/home/user/.factory/evolve-settings.json") ?? "";
    assert(settingsRaw.length > 0, "droid externalGateway writes the Evolve-owned settings file");
    const settings = JSON.parse(settingsRaw) as {
      customModels?: Array<{ model?: string; baseUrl?: string; apiKey?: string; provider?: string; extraHeaders?: Record<string, string> }>;
    };
    const custom = settings.customModels?.[0];
    assertEqual(custom?.baseUrl, EXTERNAL_URL, "droid custom model points at the external base URL VERBATIM");
    assertEqual(custom?.model, "gw-droid-model", "droid custom model carries the VERBATIM caller model");
    assertEqual(custom?.apiKey, "${FACTORY_API_KEY}", "droid custom model references the key via FACTORY_API_KEY env");
    assertEqual(custom?.provider, "generic-chat-completion-api", "droid custom model keeps the OpenAI-compatible protocol");
    assertEqual(
      Object.keys(custom?.extraHeaders ?? {}).length,
      0,
      "droid external settings carry NO LiteLLM spend headers",
    );
    assertEqual(droid.spawnEnvs.FACTORY_API_KEY, EXTERNAL_KEY, "droid spawn env injects FACTORY_API_KEY for the settings reference");
    assertEqual(droid.bootEnvs.FACTORY_API_KEY, EXTERNAL_KEY, "droid boot env injects FACTORY_API_KEY for the settings reference");
    assert(
      droid.command.includes("--settings /home/user/.factory/evolve-settings.json"),
      "droid command routes through the Evolve-owned settings file",
    );
    assert(droid.command.includes("custom:Evolve-Gateway-0"), "droid command selects the gateway custom model");

    // droid on a ROSTER alias: the settings file's custom model IS the request
    // model (droid resolves nothing itself on this route), so a roster alias
    // rides as the roster's wire id — Factory's dot-form Fable 5.1 becomes the
    // gateway's dashed Anthropic id (prod trial 6dd6b56d, 2026-09-15: the dot
    // form 404'd through the gateway's anthropic/* wildcard). NOT the
    // gatewayModelAliases table: a hosted run's key admits exactly the alias
    // and its wire id (swarm_dashboard resolveGatewayModelScope), and three of
    // that table's four rows name a route spelling the key would refuse.
    const settingsModel = (files: Map<string, string>): string | undefined => {
      const raw = files.get("/home/user/.factory/evolve-settings.json") ?? "{}";
      return (JSON.parse(raw) as { customModels?: Array<{ model?: string }> }).customModels?.[0]?.model;
    };
    const droidFable = await runHarness("droid", "claude-fable-5.1");
    assertEqual(
      settingsModel(droidFable.files),
      "claude-fable-5-1",
      "droid externalGateway settings carry the roster wire id for Factory's dot-form alias",
    );
    assert(droidFable.command.includes("custom:Evolve-Gateway-0"), "droid command still selects the gateway custom model for a roster alias");
    const droidKimi = await runHarness("droid", "kimi-k3");
    assertEqual(
      settingsModel(droidKimi.files),
      "kimi-k3",
      "droid externalGateway sends an alias that IS its wire id verbatim — never the gatewayModelAliases route spelling",
    );

    // pi and Prime Agent: routed via a per-run models.json provider entry at
    // the external base URL VERBATIM (pi never expands $VAR in baseUrl), the
    // key by env NAME, no LiteLLM headers, the caller's model VERBATIM; the
    // command selects that provider. pi spells the key reference "$VAR",
    // Prime the bare name.
    const PI_FAMILY_EXTERNAL = [
      { type: "pi", home: "/home/user/.pi/agent", keyRef: "$OPENROUTER_API_KEY" },
      { type: "prime-agent", home: "/home/user/.prime/agent", keyRef: "OPENROUTER_API_KEY" },
    ] as const;
    for (const { type, home, keyRef } of PI_FAMILY_EXTERNAL) {
      const model = `gw-${type}-model`;
      const run = await runHarness(type, model);
      const raw = run.files.get(`${home}/models.json`) ?? "";
      assert(raw.length > 0, `${type} externalGateway writes ${home}/models.json`);
      const doc = JSON.parse(raw) as {
        providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string; headers?: Record<string, string>; models?: Array<{ id?: string }> }>;
      };
      const entry = doc.providers?.evolve;
      assertEqual(entry?.baseUrl, EXTERNAL_URL, `${type} provider entry points at the external base URL VERBATIM`);
      assertEqual(entry?.api, "openai-completions", `${type} provider entry speaks OpenAI chat completions`);
      assertEqual(entry?.apiKey, keyRef, `${type} provider entry references the key by env name (${keyRef})`);
      assertEqual(entry?.headers, undefined, `${type} external entry carries NO LiteLLM spend headers`);
      assertEqual(entry?.models?.[0]?.id, model, `${type} provider entry registers the VERBATIM caller model`);
      assertEqual(run.bootEnvs.OPENROUTER_API_KEY, EXTERNAL_KEY, `${type} boot env injects OPENROUTER_API_KEY for the models.json reference`);
      assertEqual(run.spawnEnvs.OPENROUTER_API_KEY, EXTERNAL_KEY, `${type} spawn env injects OPENROUTER_API_KEY for the models.json reference`);
      assert(!("EVOLVE_API_KEY" in run.bootEnvs), `${type} externalGateway never exposes EVOLVE_API_KEY`);
      assert(run.command.includes(`--provider evolve --model ${model}`), `${type} command selects the evolve provider and the verbatim model`);
      assert(!run.command.includes("openrouter/"), `${type} command never rewrites the model to openrouter/`);
    }

    // Plain direct mode is untouched: Factory's own dot id rides --model and
    // no settings file is written.
    const directCommands = new MockCommands();
    const directSandbox = new MockSandbox("direct-droid", directCommands);
    const directKit = new Evolve()
      .withAgent({ type: "droid", model: "claude-fable-5.1", providerApiKey: "fk-direct" })
      .withSandbox(new MockProvider(directSandbox))
      .withWorkspaceMode("task")
      .withWorkingDirectory("/task");
    try {
      await directKit.run({ prompt: "solve", timeoutMs: 10_000 });
    } finally {
      await directKit.kill().catch(() => {});
    }
    assert(
      (directCommands.spawned[0] ?? "").includes("--model 'claude-fable-5.1'"),
      "droid direct mode passes Factory's dot id to --model verbatim",
    );

    // antigravity: gemini's env pair on the gateway ROOT (the caller's base
    // URL verbatim — no /gemini suffix, the Vertex route lives at the root),
    // the auto-updater off at boot and per spawn, and the CLI's own settings
    // file written with API-key auth, telemetry off and the ROSTER WIRE ID
    // registered — the slug the command then names, so `--model` accepts it.
    const agy = await runHarness("antigravity", "gemini-3.8-flash");
    assertEqual(agy.bootEnvs.GEMINI_API_KEY, EXTERNAL_KEY, "antigravity boot env injects GEMINI_API_KEY");
    assertEqual(agy.bootEnvs.GOOGLE_GEMINI_BASE_URL, EXTERNAL_URL, "antigravity boot env injects GOOGLE_GEMINI_BASE_URL VERBATIM (gateway root)");
    assertEqual(agy.spawnEnvs.GEMINI_API_KEY, EXTERNAL_KEY, "antigravity spawn env re-injects GEMINI_API_KEY");
    assertEqual(agy.spawnEnvs.GOOGLE_GEMINI_BASE_URL, EXTERNAL_URL, "antigravity spawn env re-injects GOOGLE_GEMINI_BASE_URL");
    assertEqual(agy.bootEnvs.AGY_CLI_DISABLE_AUTO_UPDATE, "true", "antigravity boot env disables the background auto-updater");
    assertEqual(agy.spawnEnvs.AGY_CLI_DISABLE_AUTO_UPDATE, "true", "antigravity spawn env re-disables the auto-updater");
    assert(!("EVOLVE_API_KEY" in agy.bootEnvs), "antigravity externalGateway never exposes EVOLVE_API_KEY");
    assert(!("GEMINI_DEFAULT_AUTH_TYPE" in agy.bootEnvs) && !("GEMINI_CLI_TRUST_WORKSPACE" in agy.bootEnvs), "antigravity carries none of gemini-cli's own env switches");
    const agySettingsRaw = agy.files.get("/home/user/.gemini/antigravity-cli/settings.json") ?? "";
    assert(agySettingsRaw.length > 0, "antigravity externalGateway writes ~/.gemini/antigravity-cli/settings.json");
    const agySettings = JSON.parse(agySettingsRaw) as {
      modelProvider?: string;
      telemetryEnabled?: boolean;
      allowNonWorkspaceAccess?: boolean;
      customModelsConfig?: { customModels?: Record<string, { modelName?: string }> };
    };
    assertEqual(agySettings.modelProvider, "gemini", "antigravity settings select the API-key auth path");
    assertEqual(agySettings.telemetryEnabled, false, "antigravity settings turn telemetry off");
    assertEqual(agySettings.allowNonWorkspaceAccess, true, "antigravity settings allow non-workspace paths");
    assertEqual(
      agySettings.customModelsConfig?.customModels?.["vertex_ai/gemini-3.8-flash"]?.modelName,
      "vertex_ai/gemini-3.8-flash",
      "antigravity externalGateway registers the roster WIRE ID (the gateway root's Vertex route) for the alias",
    );
    assert(agy.command.includes("--model 'vertex_ai/gemini-3.8-flash'"), "antigravity command names the same wire id it registered");
    assert(agy.command.includes("--effort high"), "antigravity command stamps the pinned effort");
    assert(agy.command.includes("--dangerously-skip-permissions --output-format stream-json --add-dir \"$PWD\" < /dev/null"), "antigravity command runs headless in the task workspace with stdin closed");
    const agyVerbatim = await runHarness("antigravity", "gw-agy-model");
    assert(agyVerbatim.command.includes("--model 'gw-agy-model'"), "antigravity externalGateway sends a non-roster caller model VERBATIM");
    const agyVerbatimSettings = JSON.parse(agyVerbatim.files.get("/home/user/.gemini/antigravity-cli/settings.json") ?? "{}") as {
      customModelsConfig?: { customModels?: Record<string, unknown> };
    };
    assert("gw-agy-model" in (agyVerbatimSettings.customModelsConfig?.customModels ?? {}), "antigravity registers the verbatim caller model too");
    assert(
      !directSandbox.files.writes.has("/home/user/.factory/evolve-settings.json"),
      "droid direct mode writes no Evolve-owned settings file",
    );

    // dsh: routed by the Evolve-owned route PATCH (~/.dsh/evolve-route.patch.yml),
    // which names the key and the base URL as env variables — the SDK's
    // apiKeyEnv/baseUrlEnv, injected at boot and per spawn like every direct-
    // style harness — and carries the caller's model VERBATIM, no spend
    // headers (an unset header env would be an undefined header value).
    const dsh = await runHarness("dsh", "gw-dsh-model");
    assertEqual(dsh.bootEnvs.OPENROUTER_API_KEY, EXTERNAL_KEY, "dsh boot env injects OPENROUTER_API_KEY (the patch's apiKeyEnv)");
    assertEqual(dsh.bootEnvs.EVOLVE_DSH_BASE_URL, EXTERNAL_URL, "dsh boot env injects EVOLVE_DSH_BASE_URL (the patch's baseURL read) VERBATIM");
    assertEqual(dsh.spawnEnvs.OPENROUTER_API_KEY, EXTERNAL_KEY, "dsh spawn env re-injects OPENROUTER_API_KEY");
    assertEqual(dsh.spawnEnvs.EVOLVE_DSH_BASE_URL, EXTERNAL_URL, "dsh spawn env re-injects EVOLVE_DSH_BASE_URL");
    assert(!("EVOLVE_LITELLM_TAGS" in dsh.spawnEnvs) && !("EVOLVE_LITELLM_CUSTOMER_ID" in dsh.spawnEnvs), "dsh externalGateway spawn env carries NO LiteLLM tag envs");
    const patch = dsh.files.get("/home/user/.dsh/evolve-route.patch.yml") ?? "";
    assert(patch.length > 0, "dsh externalGateway writes the Evolve-owned route patch");
    assert(patch.includes('model: "gw-dsh-model"'), "dsh route patch carries the VERBATIM caller model");
    assert(patch.includes("baseURL: !!js process.env.EVOLVE_DSH_BASE_URL"), "dsh route patch reads the base URL from EVOLVE_DSH_BASE_URL at boot");
    assert(patch.includes('apiKeyEnv: "OPENROUTER_API_KEY"'), "dsh route patch names OPENROUTER_API_KEY as the key env");
    assert(!patch.includes("headers:"), "dsh external route patch carries NO LiteLLM spend headers");
    assert(!patch.includes(EXTERNAL_KEY) && !patch.includes(EXTERNAL_URL), "dsh route patch holds neither the key nor the URL value");
    assert(patch.includes('reasoningEffort: "high"'), "dsh route patch stamps the pinned effort (high) when the caller names none");
    assert(dsh.command.includes("dsh --profile headless --patch /home/user/.dsh/evolve-route.patch.yml"), "dsh command runs the headless profile with the route patch");
    assert(dsh.command.includes("DSH_PERMISSION_MODE=danger-full-access") && dsh.command.includes("DSH_TELEMETRY_DISABLED=1"), "dsh command bypasses approvals and disables telemetry by env");
    assert(dsh.command.includes("--json"), "dsh command streams JSON");
    assert(!dsh.command.includes("--session-id"), "a first run passes no --session-id");
    assert(!dsh.command.includes("gw-dsh-model"), "the model never rides the command line (the patch carries it)");

    // dsh plain direct mode: OpenRouter's own id in the patch (the roster's
    // openrouter/ prefix is the gateway's route spelling), OpenRouter's API root.
    const dshDirectCommands = new MockCommands();
    const dshDirectSandbox = new MockSandbox("direct-dsh", dshDirectCommands);
    const dshDirectKit = new Evolve()
      .withAgent({ type: "dsh", model: "openrouter/deepseek/deepseek-v4.1-flash", providerApiKey: "or-direct" })
      .withSandbox(new MockProvider(dshDirectSandbox))
      .withWorkspaceMode("task")
      .withWorkingDirectory("/task");
    try {
      await dshDirectKit.run({ prompt: "solve", timeoutMs: 10_000 });
    } finally {
      await dshDirectKit.kill().catch(() => {});
    }
    const directPatch = dshDirectSandbox.files.writes.get("/home/user/.dsh/evolve-route.patch.yml") ?? "";
    assert(directPatch.includes('model: "deepseek/deepseek-v4.1-flash"'), "dsh direct mode names OpenRouter's own model id in the patch");
    assert(!directPatch.includes("headers:"), "dsh direct mode carries no spend headers");

    // zcode: routed by the per-run provider file alone (no --model flag, no
    // credential env read by the CLI): the caller's base URL and key VERBATIM,
    // the roster wire id, no LiteLLM headers.
    const zcode = await runHarness("zcode", "openrouter/z-ai/glm-5.3-flash");
    const providerRaw = zcode.files.get("/home/user/.zcode/v2/provider_config.json") ?? "";
    assert(providerRaw.length > 0, "zcode externalGateway writes the provider file");
    const providerDoc = JSON.parse(providerRaw) as {
      config: {
        providerConfigRules: { providerRules: Array<{ config: { access: { apiKey: string }; api: { baseUrl: string; headers?: unknown } } }> };
        defaultModelSelection: { modelId: string; options: { reasoningLevel: string } };
      };
    };
    const zcodeProvider = providerDoc.config.providerConfigRules.providerRules[0]?.config;
    assertEqual(zcodeProvider?.api.baseUrl, EXTERNAL_URL, "zcode provider file points at the external base URL VERBATIM");
    assertEqual(zcodeProvider?.access.apiKey, EXTERNAL_KEY, "zcode provider file carries the caller-minted key literally");
    assertEqual(zcodeProvider?.api.headers, undefined, "zcode external provider file carries NO LiteLLM spend headers");
    assertEqual(providerDoc.config.defaultModelSelection.modelId, "openrouter/z-ai/glm-5.3-flash", "zcode provider file names the roster wire id");
    assertEqual(providerDoc.config.defaultModelSelection.options.reasoningLevel, "high", "zcode provider file stamps the pinned effort as its reasoning level");
    assert(zcode.command.includes("zcode -p ") && zcode.command.includes("--output-format stream-json"), "zcode command is the headless stream-json prompt");
    assert(!zcode.command.includes("--model"), "zcode command carries no --model flag (the CLI has none)");
    assert(zcode.command.includes("ZCODE_MODEL_TELEMETRY_ENABLED='0'"), "zcode command switches telemetry off");
    assert(zcode.command.includes("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE='/home/user/.zcode/v2/provider_config.json'"), "zcode command pins the provider file path against a task's .env");
    assert(!("OPENAI_BASE_URL" in zcode.spawnEnvs), "zcode spawn env carries no base URL env: routing rides the provider file");

    // zcode direct mode: OpenRouter's own id, the user's key, no headers.
    const zcodeDirectCommands = new MockCommands();
    const zcodeDirectSandbox = new MockSandbox("direct-zcode", zcodeDirectCommands);
    const zcodeDirectKit = new Evolve()
      .withAgent({ type: "zcode", model: "openrouter/z-ai/glm-5.3", providerApiKey: "sk-or-direct" })
      .withSandbox(new MockProvider(zcodeDirectSandbox))
      .withWorkspaceMode("task")
      .withWorkingDirectory("/task");
    try {
      await zcodeDirectKit.run({ prompt: "solve", timeoutMs: 10_000 });
    } finally {
      await zcodeDirectKit.kill().catch(() => {});
    }
    const directDoc = JSON.parse(zcodeDirectSandbox.files.writes.get("/home/user/.zcode/v2/provider_config.json") ?? "{}") as {
      config?: {
        providerConfigRules: { providerRules: Array<{ config: { access: { apiKey: string }; api: { baseUrl: string; headers?: unknown } } }> };
        defaultModelSelection: { modelId: string };
      };
    };
    assertEqual(directDoc.config?.defaultModelSelection.modelId, "z-ai/glm-5.3", "zcode direct mode sends OpenRouter its own model id");
    assertEqual(directDoc.config?.providerConfigRules.providerRules[0]?.config.api.baseUrl, "https://openrouter.ai/api/v1", "zcode direct mode points at OpenRouter");
    assertEqual(directDoc.config?.providerConfigRules.providerRules[0]?.config.access.apiKey, "sk-or-direct", "zcode direct mode carries the user's OpenRouter key");
    assertEqual(directDoc.config?.providerConfigRules.providerRules[0]?.config.api.headers, undefined, "zcode direct mode sends no spend headers");
    assert(
      zcodeDirectCommands.runCommands.some((command) => command.endsWith("chmod 600 '/home/user/.zcode/v2/provider_config.json'")),
      "zcode hands the provider file to the home's owner and tightens it to 0600 after writing it",
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
}

/** The real captured streams the parser tests run on, one line per element. */
function fixtureLines(harness: "pi" | "prime-agent" | "zcode", name: string): string[] {
  const path = fileURLToPath(new URL(`../fixtures/${harness}/${name}.jsonl`, import.meta.url));
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

/**
 * pi and Prime Agent exit 0 whatever happened (live captures 2026-09-25), so
 * the registry's verdictFromStream makes the SDK read the run's verdict from
 * the last assistant message_end at exit 0: the captured streams (both retry
 * loops giving up, the 401, two plain runs), the synthetic shapes a capture
 * cannot show, and a control harness that keeps the exit code as its verdict.
 */
async function testPiFamilyStreamVerdict(): Promise<void> {
  console.log("\n[23] pi family: at exit 0 the last assistant message_end is the verdict (registry verdictFromStream)");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch in the verdict test: ${String(input)}`);
  }) as typeof fetch;

  const END_OK = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop","timestamp":1,"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0}}}}';
  const END_ERR = '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"500: boom","timestamp":1}}';
  const END_ABORTED = '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted","timestamp":1}}';
  // Every pi retry attempt opens with an assistant message_start (fixture model-error-retries, lines 16 and 24).
  const ASSISTANT_START = '{"type":"message_start","message":{"role":"assistant","content":[],"timestamp":1}}';
  const cases: Array<{ name: string; type: "pi" | "prime-agent" | "zcode" | "droid"; lines: string[]; reason: LifecycleReason; agent: string }> = [
    // The captured streams (tests/fixtures, the parser tests' fixtures).
    { name: "pi capture: the retry loop gave up (model-error-retries)", type: "pi", lines: fixtureLines("pi", "model-error-retries"), reason: "run_failed", agent: "error" },
    { name: "prime-agent capture: the retry loop gave up (model-error-retries)", type: "prime-agent", lines: fixtureLines("prime-agent", "model-error-retries"), reason: "run_failed", agent: "error" },
    { name: "prime-agent capture: a 401, one retry, auth_stale (model-error-401)", type: "prime-agent", lines: fixtureLines("prime-agent", "model-error-401"), reason: "run_failed", agent: "error" },
    { name: "pi capture: a plain run (tool-use)", type: "pi", lines: fixtureLines("pi", "tool-use"), reason: "run_complete", agent: "idle" },
    { name: "prime-agent capture: a plain run (tool-use)", type: "prime-agent", lines: fixtureLines("prime-agent", "tool-use"), reason: "run_complete", agent: "idle" },
    // The shapes a capture cannot show.
    { name: "pi: the last call succeeded", type: "pi", lines: [END_OK, '{"type":"agent_end","messages":[],"willRetry":false}'], reason: "run_complete", agent: "idle" },
    { name: "pi: the retry loop gave up", type: "pi", lines: [END_ERR, '{"type":"agent_end","messages":[],"willRetry":false}', '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"500: boom"}'], reason: "run_failed", agent: "error" },
    { name: "pi: a failed call that a retry recovered", type: "pi", lines: [END_ERR, '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":1}', ASSISTANT_START, END_OK, '{"type":"agent_end","messages":[],"willRetry":false}'], reason: "run_complete", agent: "idle" },
    { name: "prime-agent: a failure Prime never retried (no willRetry, no auto_retry_end)", type: "prime-agent", lines: [END_ERR, '{"type":"agent_end","messages":[]}'], reason: "run_failed", agent: "error" },
    { name: "prime-agent: the last call aborted, exit code still 0", type: "prime-agent", lines: [END_ABORTED, '{"type":"agent_end","messages":[]}'], reason: "run_failed", agent: "error" },
    // Z Code never prints a stop reason of its own: its failures are the parser's fatal errors
    // (turn.failed, a non-success turn.completed), read the same way at exit 0.
    { name: "zcode capture: the 429/500 ladder gave up (glm-E1)", type: "zcode", lines: fixtureLines("zcode", "glm-E1"), reason: "run_failed", agent: "error" },
    { name: "zcode capture: a 400 not retried (glm-PROBE1)", type: "zcode", lines: fixtureLines("zcode", "glm-PROBE1"), reason: "run_failed", agent: "error" },
    { name: "zcode capture: the turn was cancelled, no result line (glm-E3)", type: "zcode", lines: fixtureLines("zcode", "glm-E3"), reason: "run_failed", agent: "error" },
    { name: "zcode capture: a plain tool run (glm-T2-flash)", type: "zcode", lines: fixtureLines("zcode", "glm-T2-flash"), reason: "run_complete", agent: "idle" },
    {
      name: "zcode: a request failure the ladder recovered from",
      type: "zcode",
      lines: [
        '{"type":"session.updated","sessionId":"sess_v","seq":1,"timestamp":1,"payload":{"type":"model_request_failed","attempt":1,"maxAttempts":3,"statusCode":429,"errorCode":"model_rate_limited","retryable":true,"message":"Rate limit exceeded"}}',
        '{"type":"session.updated","sessionId":"sess_v","seq":2,"timestamp":1,"payload":{"usage":{"inputTokens":1,"outputTokens":1},"stopReason":"stop","content":"ok"}}',
        '{"type":"turn.completed","sessionId":"sess_v","seq":3,"timestamp":1,"payload":{"resultType":"success","response":"ok"}}',
        '{"type":"result","sessionId":"sess_v","traceId":"t","response":"ok","usage":{"source":"provider","modelRequestCount":2,"inputTokens":1,"outputTokens":1}}',
      ],
      reason: "run_complete",
      agent: "idle",
    },
    // A harness without the flag keeps the exit code as its verdict, whatever its stream said.
    { name: "droid (control): exit 0 is the verdict", type: "droid", lines: [END_ERR], reason: "run_complete", agent: "idle" },
  ];
  try {
    for (const c of cases) {
      const commands = new MockCommands();
      commands.stdoutScript = c.lines;
      const sandbox = new MockSandbox(`verdict-${c.type}`, commands);
      const kit = new Evolve()
        .withAgent({ type: c.type, providerApiKey: "direct-key" } as never)
        .withSandbox(new MockProvider(sandbox))
        .withWorkspaceMode("task")
        .withWorkingDirectory("/task");
      const reasons: LifecycleReason[] = [];
      kit.on("lifecycle", (event: LifecycleEvent) => reasons.push(event.reason));
      let result;
      try {
        result = await kit.run({ prompt: "solve", timeoutMs: 10_000 });
        const status = await kit.status();
        assertEqual(result.exitCode, 0, `${c.name}: the response keeps the CLI's own exit code, 0`);
        assert(reasons.includes(c.reason), `${c.name}: the lifecycle ends ${c.reason} (saw ${reasons.join(",")})`);
        assertEqual(status.agent, c.agent, `${c.name}: status() reports the agent ${c.agent}`);
      } finally {
        await kit.kill().catch(() => {});
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function testZcodeProviderFileLivesOnlyWhileTheRunDoes(): Promise<void> {
  console.log("\n[24] zcode: the provider file (the run's credential) is written before the spawn and removed on every exit path");
  const PROVIDER_FILE = "/home/user/.zcode/v2/provider_config.json";
  const REMOVE = `rm -f '${PROVIDER_FILE}'`;

  const scenario = (id: string): { commands: MockCommands; sandbox: MockSandbox; kit: Evolve; events: LifecycleEvent[] } => {
    const commands = new MockCommands();
    const sandbox = new MockSandbox(id, commands);
    const events: LifecycleEvent[] = [];
    const kit = new Evolve()
      .withAgent({ type: "zcode", providerApiKey: "test-openrouter-key" })
      .withSandbox(new MockProvider(sandbox))
      .withSession(id);
    kit.on("lifecycle", (event) => events.push(event));
    return { commands, sandbox, kit, events };
  };
  const removals = (commands: MockCommands): number => commands.runCommands.filter((c) => c === REMOVE).length;
  const orderIsWriteChmodSpawnRemove = (commands: MockCommands, sandbox: MockSandbox): boolean => {
    // The chmod closes the one hand-over command the write ends with (mcp/home-file.ts).
    const chmodAt = commands.runCommands.findIndex((c) => c.endsWith(`chmod 600 '${PROVIDER_FILE}'`));
    const removeAt = commands.runCommands.indexOf(REMOVE);
    return sandbox.files.writes.has(PROVIDER_FILE) && chmodAt >= 0 && removeAt > chmodAt && commands.spawned.length === 1;
  };

  {
    const { commands, sandbox, kit } = scenario("zc-ok");
    const result = await kit.run({ prompt: "hello", timeoutMs: 10_000 });
    assertEqual(result.exitCode, 0, "a successful run");
    assert(orderIsWriteChmodSpawnRemove(commands, sandbox), "success: written and tightened before the spawn, removed after the wait");
    assertEqual(removals(commands), 1, "success: exactly one removal");
  }
  {
    const { commands, sandbox, kit } = scenario("zc-fail");
    commands.exitCode = 1;
    const result = await kit.run({ prompt: "hello", timeoutMs: 10_000 });
    assertEqual(result.exitCode, 1, "a run that exits non-zero");
    assert(orderIsWriteChmodSpawnRemove(commands, sandbox), "non-zero exit: still removed after the wait");
  }
  {
    const { commands, sandbox, kit, events } = scenario("zc-int");
    commands.mode = "hang";
    const runPromise = kit.run({ prompt: "long task", timeoutMs: 60_000 });
    await waitFor(() => commands.activeHandle !== null);
    assertEqual(removals(commands), 0, "while the run is live the file stays (the CLI reads it at start)");
    assertEqual(await kit.interrupt(), true, "the run is interrupted");
    const result = await runPromise;
    assertEqual(result.exitCode, 130, "…and reports 130");
    assert(events.some((e) => e.reason === "run_interrupted"), "…with run_interrupted");
    assert(orderIsWriteChmodSpawnRemove(commands, sandbox), "interrupt: removed once the wait resolves");
  }
  {
    const { commands, sandbox, kit, events } = scenario("zc-bg");
    const run = await kit.run({ prompt: "turn 1", background: true });
    assertEqual(run.exitCode, 0, "a background run's handshake");
    await waitFor(() => events.some((e) => e.reason === "run_background_complete"));
    await waitFor(() => removals(commands) === 1);
    assert(orderIsWriteChmodSpawnRemove(commands, sandbox), "background: removed when the watched wait resolves");
  }
  {
    // Only a harness with a provider file has anything to remove.
    const commands = new MockCommands();
    const sandbox = new MockSandbox("cl-ok", commands);
    const kit = new Evolve()
      .withAgent({ type: "claude", providerApiKey: "test-key" })
      .withSandbox(new MockProvider(sandbox))
      .withSession("cl-ok");
    await kit.run({ prompt: "hello", timeoutMs: 10_000 });
    assertEqual(commands.runCommands.filter((c) => c.startsWith("rm -f ")).length, 0, "claude: no provider file, no removal");
  }
}

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Session Runtime Unit Tests");
  console.log("============================================================");

  try {
    await testStatusAndLifecycle();
    await testZcodeProviderFileLivesOnlyWhileTheRunDoes();
    await testPrepareSandboxDoesNotStartAgent();
    await testWithSecretsEvolveApiKeyBoundary();
    await testKillFlushesSessionEnd();
    await testManagedBrowserLifecycle();
    await testManagedAgentBrowserLifecycle();
    await testInterrupt();
    await testBackgroundCompletionLifecycle();
    await testPauseAndKillDoNotGetOverwritten();
    await testConcurrentRunFailsFast();
    await testSetSessionFailsWhenActiveCannotInterrupt();
    await testProviderRuntimeEndpointMissingFailsClosed();
    await testProviderRuntimeTokenServerErrorFailsClosed();
    await testProviderRuntimeBindFailureKillsSandbox();
    await testDirectSandboxProviderDeclaredOnBind();
    await testProviderRuntimeTokenDoesNotRefreshAndAddsCommandBindingEnv();
    await testProviderRuntimeTokenStaysBoundToSandbox();
    await testSetSessionRevokesProviderRuntimeToken();
    await testCodexProviderRuntimeRoutesThroughDashboardProxy();
    await testCodexConnectedSessionReassertsDashboardProxy();
    await testManagedGatewayAgentsUseRuntimeProxyLifecycle();
    await testTaskWorkspaceAndSandboxCreateOptions();
    await testCredentialSealAndArtifactCollection();
    await testRootUserThreadedThroughE2bOperations();
    await testExternalGatewaySealFlow();
    await testExternalGatewayMutualExclusivity();
    await testExternalGatewayPerHarnessWiring();
    await testPiFamilyStreamVerdict();
  } catch (error) {
    failed++;
    console.log(
      `\n  ✗ Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("============================================================");

  if (failed > 0) process.exit(1);
}

void main();
