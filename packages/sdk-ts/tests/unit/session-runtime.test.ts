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
  | "droid";

function runtimeTokenResponse(provider: RuntimeProvider = "anthropic") {
  const openAiCompatible = new Set<RuntimeProvider>([
    "openai",
    "dashscope",
    "kimi",
    "openrouter",
    "droid",
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
        options?.onStdout?.('{"type":"noop"}\n');
        finished = true;
        resolveWait?.({
          exitCode: interrupted ? 130 : 0,
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
  }> = [
    { agentType: "claude", provider: "anthropic", tokenMustBeInSandboxConfig: true },
    { agentType: "codex", provider: "openai", tokenMustBeInSandboxConfig: true },
    { agentType: "gemini", provider: "gemini", tokenMustBeInSandboxConfig: true },
    { agentType: "qwen", provider: "dashscope", tokenMustBeInSandboxConfig: true },
    { agentType: "kimi", provider: "kimi", tokenMustBeInSandboxConfig: true },
    { agentType: "opencode", provider: "openrouter", tokenMustBeInSandboxConfig: true },
    { agentType: "droid", provider: "droid", tokenMustBeInSandboxConfig: true },
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
        sandboxConfig.includes(expectedBinding),
        `${item.agentType} sandbox config includes runtime binding secret`,
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
      metadata: { evaluation: "eval-1" },
      timeoutMs: 45_000,
      workingDirectory: "/task",
    })
    .withWorkspaceMode("task");

  try {
    await kit.executeCommand("true", { timeoutMs: 1_000 });
    assertEqual(provider.createOptions?.image, "prepared-task-v1", "image is forwarded");
    assertEqual(provider.createOptions?.timeoutMs, 45_000, "timeout is forwarded");
    assertEqual(
      provider.createOptions?.metadata?.evaluation,
      "eval-1",
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
      stdout: command.startsWith("find --")
        ? "/logs/artifacts/model.patch\0" + "14\0/task/patch.diff\0" + "21\0"
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
      stdout: command.startsWith("find --")
        ? `/task/patch.diff\0${100 * 1024 * 1024 + 1}\0`
        : "",
      stderr: "",
    });
    let oversizedThrew = false;
    try {
      await kit.collectArtifacts(["patch.diff"]);
    } catch (error) {
      oversizedThrew = String(error).includes("Artifact exceeds");
    }
    assert(oversizedThrew, "artifact collection rejects oversized files before download");

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
    commands.runHandler = (command) => ({
      exitCode: command.startsWith("find --") ? 1 : 0,
      stdout: "",
      stderr: command.startsWith("find --") ? "find: permission denied" : "",
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
      if (command.startsWith("find --")) {
        return {
          exitCode: 0,
          stdout: "/task/patch.diff\0" + "9\0",
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
      (call) => call.method === "run" && call.command?.startsWith("find --"),
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
      stdout: command.startsWith("find --")
        ? "/task/patch.diff\0" + "18\0"
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
  console.log("\n[22] externalGateway wiring per harness (gemini/qwen/kimi/opencode/droid)");
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
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Session Runtime Unit Tests");
  console.log("============================================================");

  try {
    await testStatusAndLifecycle();
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
