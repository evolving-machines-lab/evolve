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

function runtimeTokenResponse(provider: "anthropic" | "openai" = "anthropic") {
  const baseUrl =
    provider === "openai"
      ? "https://dashboard.test/api/model-proxy/openai/v1"
      : "https://dashboard.test/api/model-proxy/anthropic";
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
  public mode: SpawnMode = "instant";
  public killSucceeds = true;
  public activeHandle: SandboxCommandHandle | null = null;

  async run(
    _command: string,
    _options?: SandboxRunOptions,
  ): Promise<SandboxCommandResult> {
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

async function testWithSecretsCannotOverrideEvolveApiKey(): Promise<void> {
  console.log("\n[2] withSecrets() rejects EVOLVE_API_KEY override");

  let threw = false;
  try {
    new Evolve().withSecrets({ EVOLVE_API_KEY: "owner-key" });
  } catch (error) {
    threw = true;
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes("EVOLVE_API_KEY is reserved"),
      "withSecrets() throws clear reserved-key error",
    );
  }

  assertEqual(threw, true, "withSecrets() rejects EVOLVE_API_KEY");
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

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Session Runtime Unit Tests");
  console.log("============================================================");

  try {
    await testStatusAndLifecycle();
    await testWithSecretsCannotOverrideEvolveApiKey();
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
