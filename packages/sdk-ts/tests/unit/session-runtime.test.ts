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
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockFiles implements SandboxFiles {
  async read(_path: string): Promise<string | Uint8Array> {
    return "";
  }
  async write(_path: string, _content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> {}
  async writeBatch(_files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void> {}
  async makeDir(_path: string): Promise<void> {}
}

type SpawnMode = "instant" | "hang";

class MockCommands implements SandboxCommands {
  public spawned: string[] = [];
  public mode: SpawnMode = "instant";
  public killSucceeds = true;
  public activeHandle: SandboxCommandHandle | null = null;

  async run(_command: string, _options?: SandboxRunOptions): Promise<SandboxCommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle> {
    this.spawned.push(command);
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
  readonly files: SandboxFiles;

  constructor(id: string, commands: MockCommands) {
    this.sandboxId = id;
    this.commands = commands;
    this.files = new MockFiles();
  }

  async getHost(port: number): Promise<string> {
    return `http://localhost:${port}`;
  }

  async kill(): Promise<void> {
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

  constructor(private readonly sandbox: MockSandbox) {}

  async create(_options: SandboxCreateOptions): Promise<SandboxInstance> {
    this.createCalls++;
    return this.sandbox;
  }

  async connect(_sandboxId: string, _timeoutMs?: number): Promise<SandboxInstance> {
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
  assertEqual(before.sandbox, "ready", "status() before run reports ready for attached session");
  assertEqual(before.agent, "idle", "status() before run reports idle agent");
  assertEqual(before.hasRun, true, "status() before run reports hasRun=true for attached session");
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
  assert(reasons.includes("sandbox_connected"), "lifecycle includes sandbox_connected");
  assert(reasons.includes("run_start"), "lifecycle includes run_start");
  assert(reasons.includes("run_complete"), "lifecycle includes run_complete");
  assert(events.every((e) => e.sandboxId !== undefined), "all lifecycle events include sandboxId");
}

async function testInterrupt(): Promise<void> {
  console.log("\n[2] interrupt() semantics and lifecycle");
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
  assertEqual(running.sandbox, "running", "status() while active run reports running sandbox");
  assertEqual(running.agent, "running", "status() while active run reports running agent");

  commands.killSucceeds = false;
  const failedInterrupt = await kit.interrupt();
  assertEqual(failedInterrupt, false, "interrupt() returns false when kill cannot be performed");
  const stillRunning = await kit.status();
  assertEqual(stillRunning.agent, "running", "failed interrupt keeps agent in running state");

  commands.killSucceeds = true;
  const interrupted = await kit.interrupt();
  assertEqual(interrupted, true, "interrupt() returns true when process is active");

  const result = await runPromise;
  assertEqual(result.exitCode, 130, "interrupted run exits with code 130");

  const after = await kit.status();
  assertEqual(after.sandbox, "ready", "status() after interrupt reports ready sandbox");
  assertEqual(after.agent, "interrupted", "status() after interrupt reports interrupted agent");

  const reasons = events.map((e) => e.reason);
  assertEqual(
    reasons.filter((reason) => reason === "run_interrupted").length,
    1,
    "lifecycle emits run_interrupted exactly once"
  );

  const interruptedWhenIdle = await kit.interrupt();
  assertEqual(interruptedWhenIdle, false, "interrupt() returns false when no active process");
}

async function testBackgroundCompletionLifecycle(): Promise<void> {
  console.log("\n[3] background completion emits lifecycle event");
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
  await waitFor(() => events.some((event) => event.reason === "run_background_complete"));
}

async function testPauseAndKillDoNotGetOverwritten(): Promise<void> {
  console.log("\n[4] pause()/kill() state is not overwritten by stale completion");
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
  assertEqual(paused.sandbox, "paused", "pause() leaves sandbox in paused state");
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
  console.log("\n[5] same-instance concurrent run() fails fast");
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
      "second concurrent run throws clear already-running error"
    );
  }

  assertEqual(threw, true, "second concurrent run throws immediately");
  await kit.interrupt();
  await firstRun;
}

async function testSetSessionFailsWhenActiveCannotInterrupt(): Promise<void> {
  console.log("\n[6] setSession() fails if active process cannot be interrupted");
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
      message.includes("Cannot switch session while an active process is running"),
      "setSession() throws clear error when interruption fails"
    );
  }
  assertEqual(threw, true, "setSession() rejects when active process cannot be interrupted");

  commands.killSucceeds = true;
  await kit.interrupt();
  await firstRun;
}

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("Session Runtime Unit Tests");
  console.log("============================================================");

  try {
    await testStatusAndLifecycle();
    await testInterrupt();
    await testBackgroundCompletionLifecycle();
    await testPauseAndKillDoNotGetOverwritten();
    await testConcurrentRunFailsFast();
    await testSetSessionFailsWhenActiveCannotInterrupt();
  } catch (error) {
    failed++;
    console.log(`\n  ✗ Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("============================================================");

  if (failed > 0) process.exit(1);
}

void main();
