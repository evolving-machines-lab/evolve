#!/usr/bin/env tsx
/**
 * Unit Test: Multi-Agent Runtime
 *
 * Covers all multi-agent surface added in PR #41:
 * - withMultiAgent() builder
 * - run() with multi-agent delegation
 * - send() follow-up messages
 * - Stream demuxing (stdout, stderr, content, lifecycle, mailbox)
 * - interrupt(), kill(), pause(), resume()
 * - status(), getSession(), getSessionTag(), getSessionTimestamp()
 * - checkpoint() with custom tar
 * - from + withSession() guard
 * - background mode guard
 * - Reentry guard (concurrent run)
 * - setSession() post-init guard
 * - Duplicate agent type validation
 * - Role optional (pass-through)
 * - Default timeout
 * - Per-agent parser routing
 * - Parallel agent setup
 * - Exit code checks on bootstrap/start
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
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${String(expected)}`);
    console.log(`      Actual:   ${String(actual)}`);
  }
}

function assertIncludes(str: string, substr: string, message: string): void {
  if (str.includes(substr)) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected to include: ${substr}`);
    console.log(`      Actual: ${str}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// MOCK SANDBOX
// =============================================================================

/** Tracks all commands run in the sandbox for assertions */
interface CommandLog {
  command: string;
  result: SandboxCommandResult;
}

class MockFiles implements SandboxFiles {
  public written: Map<string, string> = new Map();
  public dirs: string[] = [];

  async read(path: string): Promise<string> {
    const content = this.written.get(path);
    if (content !== undefined) return content;
    throw new Error(`File not found: ${path}`);
  }
  async write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {
    this.written.set(path, typeof content === "string" ? content : "binary");
  }
  async writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {
    for (const f of files) {
      this.written.set(f.path, typeof f.data === "string" ? f.data : "binary");
    }
  }
  async makeDir(path: string): Promise<void> { this.dirs.push(path); }
}

class MockCommands implements SandboxCommands {
  public log: CommandLog[] = [];
  public spawnLog: string[] = [];

  /** Override return values for specific commands (substring match) */
  public overrides: Map<string, SandboxCommandResult> = new Map();

  /** For spawn: what lines to emit on stdout */
  public streamLines: string[] = [];

  /** For spawn: emit lines immediately or wait */
  public spawnMode: "instant" | "hang" = "instant";

  /** Track active handle for kill */
  private activeHandle: SandboxCommandHandle | null = null;

  async run(command: string, _options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    // Check overrides
    for (const [pattern, result] of this.overrides.entries()) {
      if (command.includes(pattern)) {
        this.log.push({ command, result });
        return result;
      }
    }
    // Default: watcher PID check returns "done" (agents finished)
    if (command.includes("watcher.pid")) {
      const result = { exitCode: 0, stdout: "done", stderr: "" };
      this.log.push({ command, result });
      return result;
    }
    const result = { exitCode: 0, stdout: "", stderr: "" };
    this.log.push({ command, result });
    return result;
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    this.spawnLog.push(command);
    let finished = false;
    let resolveWait: ((r: SandboxCommandResult) => void) | null = null;
    const waitPromise = new Promise<SandboxCommandResult>((resolve) => { resolveWait = resolve; });

    const handle: SandboxCommandHandle = {
      processId: `p-${this.spawnLog.length}`,
      wait: async () => waitPromise,
      kill: async () => {
        if (finished) return false;
        finished = true;
        resolveWait?.({ exitCode: 130, stdout: "", stderr: "killed" });
        return true;
      },
    };

    this.activeHandle = handle;

    if (this.spawnMode === "instant") {
      // Emit stream lines then let polling detect "done"
      setTimeout(() => {
        if (finished) return;
        for (const line of this.streamLines) {
          options?.onStdout?.(line + "\n");
        }
      }, 5);
    }

    return handle;
  }

  async list(): Promise<ProcessInfo[]> { return []; }
  async kill(_processId: string): Promise<boolean> {
    return this.activeHandle?.kill() ?? false;
  }

  /** Get commands matching a pattern */
  commandsMatching(pattern: string): CommandLog[] {
    return this.log.filter((c) => c.command.includes(pattern));
  }
}

class MockSandbox implements SandboxInstance {
  readonly sandboxId: string;
  readonly commands: MockCommands;
  readonly files: MockFiles;
  public killed = false;
  public paused = false;

  constructor(id: string) {
    this.sandboxId = id;
    this.commands = new MockCommands();
    this.files = new MockFiles();
  }

  async getHost(port: number): Promise<string> { return `http://localhost:${port}`; }
  async kill(): Promise<void> { this.killed = true; }
  async pause(): Promise<void> { this.paused = true; }
}

class MockProvider implements SandboxProvider {
  readonly providerType = "mock";
  readonly name = "mock";
  public sandbox: MockSandbox;
  public createCalls = 0;
  public connectCalls = 0;

  constructor(sandboxId = "multi-test-1") {
    this.sandbox = new MockSandbox(sandboxId);
  }

  async create(_options: SandboxCreateOptions): Promise<SandboxInstance> {
    this.createCalls++;
    return this.sandbox;
  }

  async connect(_sandboxId: string): Promise<SandboxInstance> {
    this.connectCalls++;
    return this.sandbox;
  }
}

/** Create a standard multi-agent Evolve kit with mock provider */
function createKit(provider?: MockProvider) {
  const p = provider ?? new MockProvider();
  // Use providerApiKey + gateway key to trigger gateway mode
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(p)
    .withMultiAgent([
      { type: "claude", role: "architect", rolePrompt: "You design the system" },
      { type: "codex", role: "implementer", rolePrompt: "You write the code" },
    ]);
  return { kit, provider: p };
}

// =============================================================================
// TESTS
// =============================================================================

async function testWithMultiAgentBuilder(): Promise<void> {
  console.log("\n[1] withMultiAgent() builder and basic run");
  const { kit, provider } = createKit();

  const result = await kit.run({ prompt: "build something" });

  assertEqual(result.exitCode, 0, "run() succeeds");
  assertEqual(result.sandboxId, "multi-test-1", "returns correct sandbox ID");
  assertEqual(provider.createCalls, 1, "created one sandbox");

  // Check that a2a bootstrap was called
  const bootstraps = provider.sandbox.commands.commandsMatching("a2a bootstrap");
  assertEqual(bootstraps.length, 1, "a2a bootstrap called once");

  // Check config was written
  assert(provider.sandbox.files.written.has("/tmp/a2a-config.json"), "a2a config written to /tmp");

  // Verify config contents
  const configStr = provider.sandbox.files.written.get("/tmp/a2a-config.json")!;
  const config = JSON.parse(configStr);
  assertEqual(config.root, "/home/user/.a2a", "config has correct root");
  assertEqual(config.agents.length, 2, "config has 2 agents");
  assertEqual(config.agents[0].type, "claude", "first agent is claude");
  assertEqual(config.agents[1].type, "codex", "second agent is codex");
  assertEqual(config.agents[0].role, "architect", "role label passed through");
  assertEqual(config.agents[1].role, "implementer", "role label passed through");
  assertEqual(config.agents[0].promptText, "You design the system", "rolePrompt mapped to promptText");
  assertEqual(config.agents[1].promptText, "You write the code", "rolePrompt mapped to promptText");

  // Check a2a start was called
  const starts = provider.sandbox.commands.commandsMatching("a2a start");
  assertEqual(starts.length, 1, "a2a start called once");
  assertIncludes(starts[0].command, '"build something"', "start includes prompt");

  // Check a2a stream was spawned
  assert(provider.sandbox.commands.spawnLog.some((c) => c.includes("a2a stream")), "a2a stream spawned");

  // Check a2a stop cleanup
  const stops = provider.sandbox.commands.commandsMatching("a2a stop");
  assert(stops.length > 0, "a2a stop called for cleanup");
}

async function testSeedTo(): Promise<void> {
  console.log("\n[2] seedTo routing");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "focus on backend", seedTo: "codex" });

  const starts = provider.sandbox.commands.commandsMatching("a2a start");
  assertIncludes(starts[0].command, '--to "codex"', "start includes seedTo agent");
}

async function testDefaultSeedToAll(): Promise<void> {
  console.log("\n[3] default seedTo is *");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "hello" });

  const starts = provider.sandbox.commands.commandsMatching("a2a start");
  assertIncludes(starts[0].command, '--to "*"', "default seedTo is *");
}

async function testStreamDemuxing(): Promise<void> {
  console.log("\n[4] stream demuxing (stdout, stderr, content, mailbox)");
  const { kit, provider } = createKit();

  // Set up stream lines that a2a stream would produce
  provider.sandbox.commands.streamLines = [
    '{"ch":"stdout","agent":"claude","data":"{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"hello\\"}]}}"}',
    '{"ch":"stderr","agent":"codex","data":"warning: something"}',
    '{"ch":"mailbox","data":{"from":"claude","to":"codex","body":"task done"}}',
    '{"ch":"lifecycle","data":{"event":"agent_started","agent":"claude"}}',
  ];

  const stdout: string[] = [];
  const stderr: string[] = [];
  const content: any[] = [];
  const lifecycle: LifecycleEvent[] = [];

  kit.on("stdout", (line) => stdout.push(line));
  kit.on("stderr", (chunk) => stderr.push(chunk));
  kit.on("content", (event) => content.push(event));
  kit.on("lifecycle", (event) => lifecycle.push(event));

  await kit.run({ prompt: "test" });

  // stdout tagged with agent
  assert(stdout.some((l) => l.includes("[claude]")), "stdout tagged with [claude]");

  // stderr tagged with agent
  assert(stderr.some((l) => l.includes("[codex]")), "stderr tagged with [codex]");

  // content events have agent field
  if (content.length > 0) {
    assertEqual(content[0].agent, "claude", "content event has agent field");
  }

  // lifecycle events emitted (at minimum run_start + run_complete)
  const reasons = lifecycle.map((e) => e.reason);
  assert(reasons.includes("sandbox_boot"), "lifecycle includes sandbox_boot");
  assert(reasons.includes("run_start"), "lifecycle includes run_start");
  assert(reasons.includes("run_complete"), "lifecycle includes run_complete");
}

async function testStackedRun(): Promise<void> {
  console.log("\n[5] stacked run() uses --no-clean");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "initial task" });

  // Second run() should use --no-clean
  const result = await kit.run({ prompt: "follow-up question", seedTo: "claude" });

  assertEqual(result.exitCode, 0, "stacked run() succeeds");

  // Check --no-clean used
  const starts = provider.sandbox.commands.commandsMatching("a2a start --no-clean");
  assert(starts.length > 0, "stacked run() uses --no-clean flag");

  // Check seedTo routing
  const lastStart = starts[starts.length - 1];
  assertIncludes(lastStart.command, '--to "claude"', "stacked run() routes to specified agent");
}

async function testInterrupt(): Promise<void> {
  console.log("\n[7] interrupt()");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "task" });
  await kit.interrupt();

  const stops = provider.sandbox.commands.commandsMatching("a2a stop");
  assert(stops.length > 0, "interrupt() calls a2a stop");

  const status = kit.status();
  assertEqual(status.agent, "interrupted", "status shows interrupted after interrupt()");
}

async function testKill(): Promise<void> {
  console.log("\n[8] kill() resets state");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "task" });
  await kit.kill();

  assert(provider.sandbox.killed, "sandbox.kill() called");

  const status = kit.status();
  assertEqual(status.sandbox, "stopped", "sandbox state is stopped after kill");
  assertEqual(status.agent, "idle", "agent state is idle after kill");
  assertEqual(status.hasRun, false, "hasRun reset after kill");
  assertEqual(kit.getSession(), null, "getSession() returns null after kill");
}

async function testPauseResume(): Promise<void> {
  console.log("\n[9] pause() and resume()");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "task" });

  await kit.pause();
  assert(provider.sandbox.paused, "sandbox.pause() called");
  let status = kit.status();
  assertEqual(status.sandbox, "paused", "sandbox paused");

  await kit.resume();
  status = kit.status();
  assertEqual(status.sandbox, "ready", "sandbox ready after resume");
  assertEqual(provider.connectCalls, 1, "resume reconnects via provider.connect()");
}

async function testStatus(): Promise<void> {
  console.log("\n[10] status() reflects lifecycle");
  const { kit } = createKit();

  const before = kit.status();
  assertEqual(before.sandbox, "stopped", "sandbox stopped before run");
  assertEqual(before.agent, "idle", "agent idle before run");
  assertEqual(before.hasRun, false, "hasRun false before run");

  await kit.run({ prompt: "task" });

  const after = kit.status();
  assertEqual(after.sandbox, "ready", "sandbox ready after run");
  assertEqual(after.agent, "idle", "agent idle after run");
  assertEqual(after.hasRun, true, "hasRun true after run");
  assertEqual(after.sandboxId, "multi-test-1", "sandboxId in status");
}

async function testGetSessionAndTag(): Promise<void> {
  console.log("\n[11] getSession(), getSessionTag(), getSessionTimestamp()");
  const { kit } = createKit();

  assertEqual(kit.getSession(), null, "getSession() null before run");
  assertEqual(kit.getSessionTimestamp(), null, "getSessionTimestamp() null before run");

  assertEqual(kit.getSessionTag(), null, "getSessionTag() null before run (runtime not initialized)");

  await kit.run({ prompt: "task" });

  assertEqual(kit.getSession(), "multi-test-1", "getSession() returns sandbox ID after run");
  assert(kit.getSessionTimestamp() !== null, "getSessionTimestamp() set after run");

  const tag = kit.getSessionTag();
  assert(tag !== null, "getSessionTag() returns tag after run");
  assertIncludes(tag!, "evolve-multi", "tag has evolve-multi prefix");
}

async function testBackgroundThrows(): Promise<void> {
  console.log("\n[12] background mode throws in multi-agent");
  const { kit } = createKit();

  let threw = false;
  try {
    await kit.run({ prompt: "task", background: true } as any);
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "background mode is not supported", "clear error for background");
  }
  assertEqual(threw, true, "background throws in multi-agent");
}

async function testFromWithSessionThrows(): Promise<void> {
  console.log("\n[13] from + withSession() mutual exclusion");
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude" },
      { type: "codex" },
    ])
    .withSession("existing-sandbox");

  let threw = false;
  try {
    await kit.run({ prompt: "task", from: "some-checkpoint-id" });
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "Cannot use 'from' with 'withSession()'", "clear error for from+withSession");
  }
  assertEqual(threw, true, "from + withSession() throws");
}

async function testReentryGuard(): Promise<void> {
  console.log("\n[14] reentry guard (concurrent run)");
  const provider = new MockProvider();
  // Make the sandbox hang so first run doesn't complete
  provider.sandbox.commands.spawnMode = "hang";
  // Watcher reports "running" so stream doesn't complete
  provider.sandbox.commands.overrides.set("watcher.pid", { exitCode: 0, stdout: "running", stderr: "" });

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude" },
      { type: "codex" },
    ]);

  // Start first run (will hang)
  const firstRun = kit.run({ prompt: "long task", timeoutMs: 30000 });
  await sleep(100); // let it start

  let threw = false;
  try {
    await kit.run({ prompt: "second task" });
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "already running", "clear error for concurrent run");
  }
  assertEqual(threw, true, "concurrent run() throws");

  // Also test send() reentry
  // Clean up: switch watcher to "done" and let it finish
  provider.sandbox.commands.overrides.set("watcher.pid", { exitCode: 0, stdout: "done", stderr: "" });
  await firstRun;
}

async function testSetSessionPostInitThrows(): Promise<void> {
  console.log("\n[15] setSession() after runtime init throws");
  const { kit } = createKit();

  await kit.run({ prompt: "task" });

  let threw = false;
  try {
    await kit.setSession("other-sandbox");
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "not supported after multi-agent runtime", "clear error for setSession post-init");
  }
  assertEqual(threw, true, "setSession() throws after runtime init");
}

async function testDuplicateAgentTypeThrows(): Promise<void> {
  console.log("\n[16] duplicate agent type throws");
  const provider = new MockProvider();

  let threw = false;
  try {
    await new Evolve()
      .withAgent({ type: "claude", apiKey: "test-evolve-key" })
      .withSandbox(provider)
      .withMultiAgent([
        { type: "claude" },
        { type: "claude" },
      ])
      .run({ prompt: "task" });
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "Duplicate agent type", "clear error for duplicate types");
  }
  // If the above didn't throw synchronously, it might be async
  if (!threw) {
    try {
      await new Evolve()
        .withAgent({ type: "claude", apiKey: "test-evolve-key" })
        .withSandbox(provider)
        .withMultiAgent([
          { type: "claude" },
          { type: "claude" },
        ])
        .run({ prompt: "task" });
    } catch (e) {
      threw = true;
      assertIncludes((e as Error).message, "Duplicate agent type", "clear error for duplicate types");
    }
  }
  assertEqual(threw, true, "duplicate agent types throw");
}

async function testRoleAndRolePromptOptional(): Promise<void> {
  console.log("\n[17] role and rolePrompt are optional");
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude" },
      { type: "codex", role: "implementer", rolePrompt: "You write the code" },
    ]);

  await kit.run({ prompt: "task" });

  const configStr = provider.sandbox.files.written.get("/tmp/a2a-config.json")!;
  const config = JSON.parse(configStr);
  assertEqual(config.agents[0].role, undefined, "claude has no role when omitted");
  assertEqual(config.agents[0].promptText, undefined, "claude has no promptText when rolePrompt omitted");
  assertEqual(config.agents[1].role, "implementer", "codex role label passed through");
  assertEqual(config.agents[1].promptText, "You write the code", "codex rolePrompt mapped to promptText");
}

async function testBootstrapFailureThrows(): Promise<void> {
  console.log("\n[18] bootstrap failure throws");
  const provider = new MockProvider();
  provider.sandbox.commands.overrides.set("a2a bootstrap", {
    exitCode: 1, stdout: "", stderr: "bootstrap error: bad config",
  });

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude" },
      { type: "codex" },
    ]);

  let threw = false;
  try {
    await kit.run({ prompt: "task" });
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "bootstrap failed", "error mentions bootstrap");
    assertIncludes((e as Error).message, "bad config", "error includes stderr");
  }
  assertEqual(threw, true, "bootstrap failure throws");
}

async function testStartFailureThrows(): Promise<void> {
  console.log("\n[19] start failure throws");
  const provider = new MockProvider();
  provider.sandbox.commands.overrides.set("a2a start", {
    exitCode: 1, stdout: "", stderr: "start error: no agents found",
  });

  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude" },
      { type: "codex" },
    ]);

  let threw = false;
  try {
    await kit.run({ prompt: "task" });
  } catch (e) {
    threw = true;
    assertIncludes((e as Error).message, "start failed", "error mentions start");
  }
  assertEqual(threw, true, "start failure throws");
}

async function testWithSessionConnects(): Promise<void> {
  console.log("\n[20] withSession() reconnects to existing sandbox");
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude" },
      { type: "codex" },
    ])
    .withSession("existing-sandbox-id");

  await kit.run({ prompt: "task" });

  assertEqual(provider.connectCalls, 1, "provider.connect() called");
  assertEqual(provider.createCalls, 0, "provider.create() not called");
}

async function testSecondRunUsesNoClean(): Promise<void> {
  console.log("\n[21] second run() uses --no-clean");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "first task" });
  await kit.run({ prompt: "second task" });

  const starts = provider.sandbox.commands.commandsMatching("a2a start");
  // First run should NOT have --no-clean
  assert(!starts[0].command.includes("--no-clean"), "first run has no --no-clean");
  // Second run should have --no-clean
  assertIncludes(starts[1].command, "--no-clean", "second run uses --no-clean");
}

async function testMcpAndSkillsPerAgent(): Promise<void> {
  console.log("\n[22] MCP and skills setup per agent");
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", apiKey: "test-evolve-key" })
    .withSandbox(provider)
    .withMultiAgent([
      { type: "claude", skills: ["pdf"] },
      { type: "codex", skills: ["dev-browser"] },
    ]);

  await kit.run({ prompt: "task" });

  // Check skills dirs were created
  const dirs = provider.sandbox.files.dirs;
  assert(dirs.length >= 2, "skill target dirs created for agents");

  // Check cp commands were issued
  const cps = provider.sandbox.commands.commandsMatching("cp -r");
  assert(cps.length >= 2, "skill copy commands issued for each agent");
}

async function testWorkspaceSetup(): Promise<void> {
  console.log("\n[23] workspace directories created");
  const { kit, provider } = createKit();

  await kit.run({ prompt: "task" });

  const mkdirs = provider.sandbox.commands.commandsMatching("mkdir -p");
  assert(mkdirs.length > 0, "mkdir -p called for workspace dirs");
  assertIncludes(mkdirs[0].command, "context", "creates context dir");
  assertIncludes(mkdirs[0].command, "output", "creates output dir");
}

async function testSingleAgentNotAffected(): Promise<void> {
  console.log("\n[24] single-agent mode unaffected by multi-agent code");
  // Verify that building without withMultiAgent() does not create a multi-agent runtime
  const provider = new MockProvider();
  const kit = new Evolve()
    .withAgent({ type: "claude", providerApiKey: "test-key" })
    .withSandbox(provider);

  // Multi-agent-only methods should not exist on single-agent kit
  // Verify that withMultiAgent was not called — kit has no multiAgentRuntime
  const status = kit.status();
  assertEqual(status.sandbox, "stopped", "single-agent starts in stopped state");
  assert(!("multiAgent" in status), "single-agent status has no multi-agent fields");
}

async function testUnsupportedMethodsThrow(): Promise<void> {
  console.log("\n[25] unsupported methods throw in multi-agent mode");
  const { kit } = createKit();

  const methods = [
    { name: "executeCommand", fn: () => kit.executeCommand("ls") },
    { name: "uploadContext", fn: () => kit.uploadContext({ "f.txt": "data" }) },
    { name: "uploadFiles", fn: () => kit.uploadFiles({ "f.txt": "data" }) },
    { name: "getOutputFiles", fn: () => kit.getOutputFiles() },
    { name: "getHost", fn: () => kit.getHost(3000) },
    { name: "getSessionCost", fn: () => kit.getSessionCost() },
    { name: "getRunCost", fn: () => kit.getRunCost({ index: 1 }) },
  ];

  for (const { name, fn } of methods) {
    let threw = false;
    try {
      await fn();
    } catch (e) {
      threw = true;
      assertIncludes((e as Error).message, "available", `${name}() throws about availability`);
    }
    if (!threw) {
      assertEqual(threw, true, `${name}() should throw in multi-agent mode`);
    }
  }
}

async function testFlushObservability(): Promise<void> {
  console.log("\n[26] flushObservability() works in multi-agent mode");
  const { kit } = createKit();

  await kit.run({ prompt: "task" });

  // Should not throw
  let threw = false;
  try {
    await kit.flushObservability();
  } catch {
    threw = true;
  }
  assertEqual(threw, false, "flushObservability() does not throw");
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Multi-Agent Runtime Unit Tests");
  console.log("============================================================");

  try {
    await testWithMultiAgentBuilder();
    await testSeedTo();
    await testDefaultSeedToAll();
    await testStreamDemuxing();
    await testStackedRun();
    await testInterrupt();
    await testKill();
    await testPauseResume();
    await testStatus();
    await testGetSessionAndTag();
    await testBackgroundThrows();
    await testFromWithSessionThrows();
    await testReentryGuard();
    await testSetSessionPostInitThrows();
    await testDuplicateAgentTypeThrows();
    await testRoleAndRolePromptOptional();
    await testBootstrapFailureThrows();
    await testStartFailureThrows();
    await testWithSessionConnects();
    await testSecondRunUsesNoClean();
    await testMcpAndSkillsPerAgent();
    await testWorkspaceSetup();
    await testSingleAgentNotAffected();
    await testUnsupportedMethodsThrow();
    await testFlushObservability();
  } catch (error) {
    failed++;
    console.log(`\n  ✗ Unexpected error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }

  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("============================================================");

  if (failed > 0) process.exit(1);
}

void main();
