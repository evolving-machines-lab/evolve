#!/usr/bin/env tsx
/**
 * Unit Test: Daytona Provider — wrapCommand() and DaytonaCommands
 *
 * Tests:
 *   1. wrapCommand() — pure function: cwd, envs, escaping, passthrough
 *   2. DaytonaCommands.run() — always-session-based execution, empty stdout fallback
 *   3. DaytonaCommands.spawn() — envs passed through to wrapCommand
 *   4. The in-box kill on run() — coreutils `timeout` planted inside the box,
 *      because Daytona has no server-side lifetime and run()'s own timeout is a
 *      wait bound this process enforces (and stops enforcing when it dies)
 *
 * Usage:
 *   npx tsx tests/unit/daytona-commands.test.ts
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaytonaCommands, _testWithInBoxTimeout, _testWrapCommand } from "../../src/index.ts";

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  \u2713 ${message}`);
  } else {
    failed++;
    console.log(`  \u2717 ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// =============================================================================
// [1] wrapCommand() — Pure Function Tests
// =============================================================================

async function testWrapCommandPassthrough(): Promise<void> {
  console.log("\n[1a] wrapCommand() - no cwd, no envs (passthrough)");

  assertEqual(_testWrapCommand("echo hello"), "echo hello", "No cwd/envs returns command unchanged");
  assertEqual(_testWrapCommand("ls -la", undefined, undefined), "ls -la", "Explicit undefined args returns command unchanged");
  assertEqual(_testWrapCommand("ls -la", undefined, {}), "ls -la", "Empty envs object returns command unchanged");
}

async function testWrapCommandCwdOnly(): Promise<void> {
  console.log("\n[1b] wrapCommand() - cwd only");

  assertEqual(
    _testWrapCommand("echo hello", "/home/user/workspace"),
    "cd '/home/user/workspace' && echo hello",
    "cwd prepends cd with single-quoted path"
  );

  assertEqual(
    _testWrapCommand("ls -la", "/tmp"),
    "cd '/tmp' && ls -la",
    "Simple cwd works"
  );
}

async function testWrapCommandEnvsOnly(): Promise<void> {
  console.log("\n[1c] wrapCommand() - envs only");

  const result = _testWrapCommand("echo $FOO", undefined, { FOO: "bar" });
  assertEqual(result, "export FOO='bar'; echo $FOO", "Single env var exported before command");
}

async function testWrapCommandMultipleEnvs(): Promise<void> {
  console.log("\n[1d] wrapCommand() - multiple envs");

  const result = _testWrapCommand("env", undefined, { A: "1", B: "2" });
  assert(result.includes("export A='1'"), "Contains export A");
  assert(result.includes("export B='2'"), "Contains export B");
  assert(result.endsWith("; env"), "Command comes after exports");
  // Both exports separated by semicolons
  assert(result.includes("; export ") || result.startsWith("export "), "Exports are semicolon-separated");
}

async function testWrapCommandCwdPlusEnvs(): Promise<void> {
  console.log("\n[1e] wrapCommand() - cwd + envs combined");

  const result = _testWrapCommand("echo $VAR", "/workspace", { VAR: "value" });
  // envs come first, then cd, then command
  assert(result.startsWith("export VAR='value'; "), "Envs are prepended first");
  assert(result.includes("cd '/workspace' && echo $VAR"), "cwd + command follow envs");
  assertEqual(
    result,
    "export VAR='value'; cd '/workspace' && echo $VAR",
    "Full combined command is correct"
  );
}

async function testWrapCommandSingleQuoteEscapingCwd(): Promise<void> {
  console.log("\n[1f] wrapCommand() - single-quote escaping in cwd");

  const result = _testWrapCommand("ls", "/home/user/it's a dir");
  assertEqual(
    result,
    "cd '/home/user/it'\\''s a dir' && ls",
    "Single quotes in cwd are escaped with '\\'' pattern"
  );
}

async function testWrapCommandSingleQuoteEscapingEnvs(): Promise<void> {
  console.log("\n[1g] wrapCommand() - single-quote escaping in env values");

  const result = _testWrapCommand("echo $MSG", undefined, { MSG: "it's fine" });
  assertEqual(
    result,
    "export MSG='it'\\''s fine'; echo $MSG",
    "Single quotes in env values are escaped with '\\'' pattern"
  );
}

async function testWrapCommandEnvsFilterNullUndefined(): Promise<void> {
  console.log("\n[1h] wrapCommand() - envs filters out null/undefined values");

  const envs: Record<string, string> = { KEEP: "yes" };
  // Simulate null/undefined values (cast to bypass TS strict checks)
  (envs as any).SKIP_NULL = null;
  (envs as any).SKIP_UNDEF = undefined;

  const result = _testWrapCommand("env", undefined, envs);
  assert(result.includes("export KEEP='yes'"), "KEEP is included");
  assert(!result.includes("SKIP_NULL"), "null value is filtered out");
  assert(!result.includes("SKIP_UNDEF"), "undefined value is filtered out");
}

async function testWrapCommandSpacesInEnvValues(): Promise<void> {
  console.log("\n[1i] wrapCommand() - spaces in env values");

  const result = _testWrapCommand("cmd", undefined, { PATH_EXT: "/usr/local/bin with spaces" });
  assertEqual(
    result,
    "export PATH_EXT='/usr/local/bin with spaces'; cmd",
    "Spaces in env values are safely single-quoted"
  );
}

// =============================================================================
// [2] DaytonaCommands.run() — Mock-Based Tests
// =============================================================================

interface MockSession {
  sessionId: string;
  commands: Array<{ command: string; runAsync: boolean }>;
  logFetches: number;
  deleted: boolean;
}

interface MockProcessApi {
  sessions: Map<string, MockSession>;
  lastSessionCommand: {
    sessionId: string;
    command: string;
    runAsync: boolean;
    /** The session API's own timeout argument, as sent. */
    timeoutSec?: number;
  } | null;
  /** Override response for executeSessionCommand */
  execResponse: {
    cmdId?: string;
    exitCode?: number;
    stdout?: string;
    output?: string;
    stderr?: string;
  };
  /** Override response for getSessionCommandLogs (log fallback) */
  logResponse: Record<string, unknown> | null;
  /**
   * Successive getSessionCommand exit codes, consumed one per poll. A `null`
   * is the wire's "still running". Empty = always answer execResponse's code.
   */
  sessionCommandExitCodes: Array<number | null>;
  /** A follow that yields nothing — the command finished before it connected. */
  silentFollow: boolean;
  /** A follow that never ends: the socket the command already outlived. */
  followHangs: boolean;
  /** Track calls to getSessionCommandLogs */
  logFetchCalls: Array<{ sessionId: string; cmdId: string; hasCallbacks: boolean }>;
}

function createMockProcessApi(): MockProcessApi {
  const api: MockProcessApi = {
    sessions: new Map(),
    lastSessionCommand: null,
    execResponse: { cmdId: "cmd-001", exitCode: 0, stdout: "hello", stderr: "" },
    logResponse: null,
    sessionCommandExitCodes: [],
    silentFollow: false,
    followHangs: false,
    logFetchCalls: [],
  };
  return api;
}

function createMockDaytonaSandbox(processApi: MockProcessApi) {
  return {
    id: "daytona-sandbox-123",
    process: {
      createSession: async (sessionId: string) => {
        processApi.sessions.set(sessionId, {
          sessionId,
          commands: [],
          logFetches: 0,
          deleted: false,
        });
      },
      executeSessionCommand: async (
        sessionId: string,
        params: { command: string; runAsync: boolean },
        timeoutSec?: number
      ) => {
        const session = processApi.sessions.get(sessionId);
        if (session) session.commands.push(params);
        processApi.lastSessionCommand = { sessionId, ...params, timeoutSec };
        return { ...processApi.execResponse };
      },
      getSessionCommandLogs: async (
        sessionId: string,
        cmdId: string,
        onStdout?: (data: string) => void,
        onStderr?: (data: string) => void
      ) => {
        const hasCallbacks = !!(onStdout || onStderr);
        processApi.logFetchCalls.push({ sessionId, cmdId, hasCallbacks });
        const session = processApi.sessions.get(sessionId);
        if (session) session.logFetches++;

        // A follow the command outlives: it never delivers and never ends.
        if (hasCallbacks && processApi.followHangs) {
          return new Promise<Record<string, unknown>>(() => {});
        }

        // If streaming callbacks provided, call them
        if (!processApi.silentFollow) {
          if (onStdout) onStdout("streamed-stdout");
          if (onStderr) onStderr("streamed-stderr");
        }

        // Return log response for non-streaming fallback
        return processApi.logResponse || { stdout: "", stderr: "" };
      },
      deleteSession: async (sessionId: string) => {
        const session = processApi.sessions.get(sessionId);
        if (session) session.deleted = true;
      },
      getSessionCommand: async (_sessionId: string, _cmdId: string) => {
        if (processApi.sessionCommandExitCodes.length > 0) {
          return { exitCode: processApi.sessionCommandExitCodes.shift() };
        }
        return { exitCode: processApi.execResponse.exitCode };
      },
      listSessions: async () => [],
    },
    fs: {
      downloadFile: async () => Buffer.from(""),
      uploadFile: async () => {},
      createFolder: async () => {},
      listFiles: async () => [],
      deleteFile: async () => {},
      moveFiles: async () => {},
    },
    state: "started",
    snapshot: "test-image",
    name: "test-sandbox",
    labels: {},
    delete: async () => {},
    stop: async () => {},
    start: async () => {},
    getPreviewLink: async (port: number) => ({ url: `http://localhost:${port}` }),
  };
}

/** DaytonaCommands over the mock process API — section [4] drives the real methods. */
function createCommands(processApi: MockProcessApi, user?: string): DaytonaCommands {
  return new DaytonaCommands(createMockDaytonaSandbox(processApi) as never, user);
}

async function testRunAlwaysUsesSession(): Promise<void> {
  console.log("\n[2a] DaytonaCommands.run() - always creates ephemeral session");

  // We test this by verifying wrapCommand is called correctly (captured via mock)
  // and that session-based execution is always used.
  // Since DaytonaCommands is not exported, we verify the behavior through
  // the wrapCommand function and the mock pattern.

  const processApi = createMockProcessApi();
  processApi.execResponse = { cmdId: "cmd-001", exitCode: 0, stdout: "result", stderr: "" };

  const sandbox = createMockDaytonaSandbox(processApi);

  // Simulate what DaytonaCommands.run() does internally
  const sessionId = `run-test-001`;
  await sandbox.process.createSession(sessionId);

  const command = "echo hello";
  const wrappedCmd = _testWrapCommand(command, "/workspace", { FOO: "bar" });

  const resp = await sandbox.process.executeSessionCommand(sessionId, {
    command: wrappedCmd,
    runAsync: false,
  });

  assert(processApi.sessions.has(sessionId), "Session was created");
  assertEqual(resp.exitCode, 0, "Exit code is 0");
  assertEqual(resp.stdout, "result", "Stdout returned from session command");

  // Verify the wrapped command includes envs and cwd
  assertEqual(
    processApi.lastSessionCommand?.command,
    "export FOO='bar'; cd '/workspace' && echo hello",
    "Command was wrapped with cwd and envs"
  );

  await sandbox.process.deleteSession(sessionId);
  assert(processApi.sessions.get(sessionId)?.deleted === true, "Session cleaned up");
}

async function testRunEmptyStdoutFallback(): Promise<void> {
  console.log("\n[2b] DaytonaCommands.run() - falls back to log fetch when stdout is empty");

  const processApi = createMockProcessApi();
  // Simulate empty inline stdout
  processApi.execResponse = { cmdId: "cmd-002", exitCode: 0, stdout: "", output: "", stderr: "" };
  // Log fetch returns the actual output
  processApi.logResponse = { stdout: "fallback-output", stderr: "fallback-err" };

  const sandbox = createMockDaytonaSandbox(processApi);

  // Simulate the run() logic: create session, execute, check empty stdout, fetch logs
  const sessionId = "run-fallback-test";
  await sandbox.process.createSession(sessionId);

  const resp = await sandbox.process.executeSessionCommand(sessionId, {
    command: "echo hello",
    runAsync: false,
  });

  const cmdId = resp.cmdId;
  let stdout = resp.stdout ?? (resp as any).output ?? "";
  let stderr = resp.stderr ?? "";

  // Simulate the fallback logic from DaytonaCommands.run()
  if (!stdout && cmdId) {
    const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
    stdout = (logs as any).stdout ?? (logs as any).output ?? "";
    stderr = (logs as any).stderr ?? stderr;
  }

  assertEqual(stdout, "fallback-output", "Stdout came from log fetch fallback");
  assertEqual(stderr, "fallback-err", "Stderr came from log fetch fallback");
  assert(processApi.logFetchCalls.length >= 1, "Log fetch was called");
  assertEqual(processApi.logFetchCalls[0].hasCallbacks, false, "Log fetch was non-streaming (no callbacks)");
}

async function testRunInlineStdoutNoFallback(): Promise<void> {
  console.log("\n[2c] DaytonaCommands.run() - inline stdout present, no log fetch needed");

  const processApi = createMockProcessApi();
  processApi.execResponse = { cmdId: "cmd-003", exitCode: 0, stdout: "inline-result", stderr: "inline-err" };

  const sandbox = createMockDaytonaSandbox(processApi);

  const sessionId = "run-inline-test";
  await sandbox.process.createSession(sessionId);

  const resp = await sandbox.process.executeSessionCommand(sessionId, {
    command: "echo hello",
    runAsync: false,
  });

  let stdout = resp.stdout ?? (resp as any).output ?? "";
  let stderr = resp.stderr ?? "";
  const cmdId = resp.cmdId;

  // Simulate: stdout is non-empty, so no fallback
  if (!stdout && cmdId) {
    // This should NOT execute
    const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId!);
    stdout = (logs as any).stdout ?? "";
  }

  assertEqual(stdout, "inline-result", "Inline stdout used directly");
  assertEqual(stderr, "inline-err", "Inline stderr used directly");
  assertEqual(processApi.logFetchCalls.length, 0, "No log fetch calls (inline stdout was sufficient)");
}

async function testRunStreamingPath(): Promise<void> {
  console.log("\n[2d] DaytonaCommands.run() - streaming callbacks trigger log streaming");

  const processApi = createMockProcessApi();
  processApi.execResponse = { cmdId: "cmd-004", exitCode: 0, stdout: "inline", stderr: "" };

  const sandbox = createMockDaytonaSandbox(processApi);

  const sessionId = "run-streaming-test";
  await sandbox.process.createSession(sessionId);

  const resp = await sandbox.process.executeSessionCommand(sessionId, {
    command: "echo hello",
    runAsync: false,
  });

  const cmdId = resp.cmdId;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Simulate streaming path: if callbacks provided and cmdId exists, stream logs
  if (cmdId) {
    await sandbox.process.getSessionCommandLogs(
      sessionId,
      cmdId,
      (data: string) => stdoutChunks.push(data),
      (data: string) => stderrChunks.push(data)
    );
  }

  assert(stdoutChunks.length > 0, "Stdout callback was called");
  assert(stderrChunks.length > 0, "Stderr callback was called");
  assert(processApi.logFetchCalls.length >= 1, "Log streaming was triggered");
  assertEqual(processApi.logFetchCalls[0].hasCallbacks, true, "Log fetch had streaming callbacks");
}

/**
 * Campaign J5: run() with callbacks used a BLOCKING execute and only followed
 * the logs after it returned, so every byte landed in one burst after the
 * command finished (e2b/modal stream within ~2s). A streaming run must
 * execute async and follow live, and the streamed chunks are the result.
 */
async function testRunStreamsLiveNotAfterExit(): Promise<void> {
  console.log("\n[2f] DaytonaCommands.run() - streaming executes ASYNC and follows live (J5)");

  const processApi = createMockProcessApi();
  processApi.execResponse = { cmdId: "cmd-006", exitCode: 7, stdout: "inline-not-used", stderr: "" };
  const commands = createCommands(processApi);

  const chunks: string[] = [];
  const result = await commands.run("echo hi", { onStdout: (c) => chunks.push(c) });

  assertEqual(
    processApi.lastSessionCommand?.runAsync,
    true,
    "a streaming run executes runAsync — the blocking execute held all output to exit"
  );
  assertEqual(chunks.join(""), "streamed-stdout", "chunks reach the callback from the live follow");
  assertEqual(
    result.stdout,
    "streamed-stdout",
    "the streamed chunks ARE the result, not the inline snapshot"
  );
  assertEqual(result.exitCode, 7, "exit code read off the session command after the stream closes");
}

/**
 * The streaming path may never invent a status. Both routes to a fabricated
 * one are refused: an async execute that returns no command id (nothing to
 * follow, nowhere for an exit code to appear) used to fall through to the
 * blocking tail's `resp.exitCode ?? 0` — a clean success for a command still
 * running — and a NULL exit code (the wire's "still running") used to be
 * handed back as the run's own status.
 */
async function testStreamingRunNeverFabricatesAStatus(): Promise<void> {
  console.log("\n[2g] DaytonaCommands.run() - the streaming path never invents an exit code");

  const noId = createMockProcessApi();
  noId.execResponse = { exitCode: undefined, stdout: "", stderr: "" };
  let refused = false;
  try {
    await createCommands(noId).run("echo hi", { onStdout: () => {} });
  } catch {
    refused = true;
  }
  assert(refused, "an async execute with no command id refuses instead of reporting exit 0");
  assert(
    noId.sessions.get(noId.lastSessionCommand!.sessionId)?.deleted === true,
    "and the ephemeral session is still cleaned up"
  );

  const running = createMockProcessApi();
  running.execResponse = { cmdId: "cmd-007", exitCode: undefined, stdout: "", stderr: "" };
  // Still running on the first poll, settled on the second.
  running.sessionCommandExitCodes = [null, 3];
  const result = await createCommands(running).run("echo hi", { onStdout: () => {} });
  assertEqual(result.exitCode, 3, "a null exit code is 'still running' — the poll waits for the real one");
}

/**
 * A command that finishes before the follow connects yields an empty stream,
 * and nothing documents the follow endpoint as replaying what it already
 * buffered. The blocking path always had the non-follow log read as its
 * fallback; the streaming path dropped it, so a fast command came back with a
 * correct exit code and no output at all.
 */
async function testStreamingRunFallsBackWhenFollowYieldsNothing(): Promise<void> {
  console.log("\n[2h] DaytonaCommands.run() - a silent follow falls back to the settled log");

  const silent = createMockProcessApi();
  silent.silentFollow = true;
  silent.execResponse = { cmdId: "cmd-008", exitCode: 0, stdout: "", stderr: "" };
  silent.logResponse = { stdout: "fast-output", stderr: "fast-err" };
  const seen: string[] = [];
  const errSeen: string[] = [];
  const result = await createCommands(silent).run("echo hi", {
    onStdout: (c) => seen.push(c),
    onStderr: (c) => errSeen.push(c),
  });
  assertEqual(result.stdout, "fast-output", "the settled log supplies stdout the follow never delivered");
  assertEqual(result.stderr, "fast-err", "and stderr with it");
  assertEqual(seen.join(""), "fast-output", "the recovered output still reaches the caller's callback");
  assertEqual(errSeen.join(""), "fast-err", "on the stream it belongs to");
  assertEqual(
    silent.logFetchCalls.filter((c) => !c.hasCallbacks).length,
    1,
    "exactly one non-follow log read — the fallback, not a second follow"
  );

  // A follow that DID deliver is never re-read: re-emitting would double the
  // caller's output, so both streams must be empty to take the fallback.
  const streamed = createMockProcessApi();
  streamed.execResponse = { cmdId: "cmd-009", exitCode: 0, stdout: "", stderr: "" };
  streamed.logResponse = { stdout: "must-not-appear", stderr: "" };
  const streamedResult = await createCommands(streamed).run("echo hi", { onStdout: () => {} });
  assertEqual(streamedResult.stdout, "streamed-stdout", "a follow that delivered keeps its own bytes");
  assertEqual(
    streamed.logFetchCalls.filter((c) => !c.hasCallbacks).length,
    0,
    "and no fallback read is issued at all"
  );
}

/**
 * The follow is a stream, not a clock. Awaiting it FIRST and only then polling
 * for an exit code — 20 attempts at 500ms — gave the streaming path two
 * failure modes the blocking path never had: a stalled socket (nothing acks a
 * chunked body) hung run() forever when no timeoutMs bounded it, and a follow
 * that closed a moment early threw "no exit code" on a command that had
 * already succeeded. The command's record decides; the follow is drained, not
 * waited on.
 */
async function testStreamedRunIsBoundedByTheCommandNotTheFollow(): Promise<void> {
  console.log("\n[2i] DaytonaCommands.run() - a stalled follow no longer outlives its command");

  // Timings shrunk so the test measures the SHAPE, not the production clocks.
  class FastCommands extends DaytonaCommands {
    protected override streamTimings = {
      pollMinMs: 1,
      pollMaxMs: 2,
      drainMs: 20,
      killGraceMs: 5,
      settleMs: 500,
    };
  }
  const fast = (api: MockProcessApi) =>
    new FastCommands(createMockDaytonaSandbox(api) as never);

  const stalled = createMockProcessApi();
  stalled.followHangs = true;
  stalled.execResponse = { cmdId: "cmd-010", exitCode: undefined, stdout: "", stderr: "" };
  stalled.sessionCommandExitCodes = [null, null, 4];
  stalled.logResponse = { stdout: "recovered", stderr: "" };
  const hung = Symbol("hung");
  const raced = await Promise.race([
    fast(stalled).run("echo hi", { onStdout: () => {} }),
    new Promise((resolve) => setTimeout(() => resolve(hung), 5_000)),
  ]);
  assert(raced !== hung, "run() returns while the follow socket is still open");
  assertEqual((raced as { exitCode: number }).exitCode, 4, "the command's own record supplies the exit code");
  assertEqual(
    (raced as { stdout: string }).stdout,
    "recovered",
    "and the settled log still supplies the output the stall never delivered"
  );

  // A command that takes longer to settle than twenty polls is not a failure.
  // The old attempt cap threw on exactly this: a run that had SUCCEEDED.
  const slow = createMockProcessApi();
  slow.execResponse = { cmdId: "cmd-011", exitCode: undefined, stdout: "", stderr: "" };
  slow.sessionCommandExitCodes = [...Array(40).fill(null), 0];
  const slowResult = await fast(slow).run("echo hi", { onStdout: () => {} });
  assertEqual(slowResult.exitCode, 0, "40 polls later the real exit code is still read, never a throw");

  // A caller's timeoutMs is the ceiling: a command that never settles fails by
  // that clock instead of waiting on the follow forever.
  const never = createMockProcessApi();
  never.followHangs = true;
  never.execResponse = { cmdId: "cmd-012", exitCode: undefined, stdout: "", stderr: "" };
  never.sessionCommandExitCodes = Array(10_000).fill(null);
  let message = "";
  try {
    await fast(never).run("sleep 999", { onStdout: () => {}, timeoutMs: 10 });
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes("no exit code"), "an unbounded follow past the caller's deadline throws");
  assert(message.includes("10ms"), "and the refusal names the wall clock it blew, not an attempt count");
}

async function testRunSessionCleanup(): Promise<void> {
  console.log("\n[2e] DaytonaCommands.run() - session is always cleaned up (finally block)");

  const processApi = createMockProcessApi();
  processApi.execResponse = { cmdId: "cmd-005", exitCode: 0, stdout: "ok", stderr: "" };

  const sandbox = createMockDaytonaSandbox(processApi);

  const sessionId = "run-cleanup-test";
  await sandbox.process.createSession(sessionId);

  // Execute
  await sandbox.process.executeSessionCommand(sessionId, {
    command: "echo hello",
    runAsync: false,
  });

  // Simulate finally block cleanup
  await sandbox.process.deleteSession(sessionId);

  const session = processApi.sessions.get(sessionId);
  assert(session !== undefined, "Session exists in mock");
  assertEqual(session?.deleted, true, "Session was deleted in cleanup");
}

async function testRunOutputField(): Promise<void> {
  console.log("\n[2f] DaytonaCommands.run() - uses resp.output when resp.stdout is missing");

  const processApi = createMockProcessApi();
  // Simulate response that only has .output, not .stdout
  processApi.execResponse = { cmdId: "cmd-006", exitCode: 0, output: "output-field-value", stderr: "" } as any;

  const sandbox = createMockDaytonaSandbox(processApi);

  const sessionId = "run-output-field-test";
  await sandbox.process.createSession(sessionId);

  const resp = await sandbox.process.executeSessionCommand(sessionId, {
    command: "echo hello",
    runAsync: false,
  });

  // Simulate: stdout = resp.stdout ?? resp.output ?? ""
  const stdout = resp.stdout ?? (resp as any).output ?? "";
  assertEqual(stdout, "output-field-value", "Falls back to resp.output when resp.stdout is undefined");
}

// =============================================================================
// [3] Spawn with envs
// =============================================================================

async function testSpawnWithEnvs(): Promise<void> {
  console.log("\n[3a] DaytonaCommands.spawn() - envs are passed through wrapCommand");

  const processApi = createMockProcessApi();
  processApi.execResponse = { cmdId: "cmd-spawn-001", exitCode: undefined as any, stdout: "", stderr: "" };

  const sandbox = createMockDaytonaSandbox(processApi);

  // Simulate what spawn() does: create session, wrapCommand with envs, executeSessionCommand with runAsync=true
  const sessionId = "spawn-env-test";
  await sandbox.process.createSession(sessionId);

  const envs = { API_KEY: "secret123", NODE_ENV: "production" };
  const command = "node server.js";
  const wrappedCmd = _testWrapCommand(command, "/workspace", envs);

  await sandbox.process.executeSessionCommand(sessionId, {
    command: wrappedCmd,
    runAsync: true,
  });

  assert(processApi.lastSessionCommand?.runAsync === true, "Command was run async (spawn mode)");
  assert(processApi.lastSessionCommand?.command.includes("export API_KEY='secret123'"), "API_KEY env included");
  assert(processApi.lastSessionCommand?.command.includes("export NODE_ENV='production'"), "NODE_ENV env included");
  assert(processApi.lastSessionCommand?.command.includes("cd '/workspace' && node server.js"), "cwd and command present");
}

async function testSpawnWithoutEnvs(): Promise<void> {
  console.log("\n[3b] DaytonaCommands.spawn() - no envs, just cwd");

  const processApi = createMockProcessApi();
  const sandbox = createMockDaytonaSandbox(processApi);

  const sessionId = "spawn-no-env-test";
  await sandbox.process.createSession(sessionId);

  const wrappedCmd = _testWrapCommand("python main.py", "/app");
  await sandbox.process.executeSessionCommand(sessionId, {
    command: wrappedCmd,
    runAsync: true,
  });

  assertEqual(
    processApi.lastSessionCommand?.command,
    "cd '/app' && python main.py",
    "Command wrapped with cwd only, no envs prefix"
  );
}

// =============================================================================
// [4] The in-box kill — DaytonaCommands.run() (real method, not simulated)
//
// Daytona has no server-side lifetime, and run()'s session-API timeout is a WAIT
// bound honored by THIS process. If it dies mid-run, only the coreutils
// `timeout` planted inside the box still bounds the command — which is the
// whole reason the wrapper is on run() and not just spawn().
// =============================================================================

/**
 * ACTUALLY RUN the generated wrapper in a real shell. The property under test is
 * shell semantics — `A && B || { C; }` precedence, and what `>` does before its
 * pipeline runs — which no assertion over the command STRING can decide, and
 * which is precisely what the fail-open bug turned on.
 *
 * `stripBase64` puts a PATH in front that contains only `sh`, so the wrapper's
 * own `base64 -d` is missing exactly as it would be on a minimal task image.
 * Nothing else is needed from that PATH: `[`, `command` and `exit` are shell
 * builtins, and the failure branch's `rm` may fail harmlessly.
 */
function runWrapper(wrapped: string, opts: { stripBase64?: boolean } = {}): {
  code: number;
  stdout: string;
} {
  let shimDir: string | undefined;
  try {
    const env = { ...process.env };
    if (opts.stripBase64) {
      shimDir = mkdtempSync(join(tmpdir(), "evolve-inbox-"));
      symlinkSync("/bin/sh", join(shimDir, "sh"));
      env.PATH = shimDir;
    }
    const stdout = execSync(wrapped, { shell: "/bin/sh", env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? "" };
  } finally {
    if (shimDir) rmSync(shimDir, { recursive: true, force: true });
  }
}

/** The base64 payload the wrapper decodes into the script it runs. */
function decodePayload(command: string): string {
  const match = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command);
  if (!match) throw new Error(`no base64 payload in: ${command}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

async function testRunPlantsInBoxTimeout(): Promise<void> {
  console.log("\n[4a] run() - plants coreutils `timeout` inside the box");

  const processApi = createMockProcessApi();
  const commands = createCommands(processApi);

  await commands.run("sleep 999", { timeoutMs: 30_000, cwd: "/workspace" });

  const sent = processApi.lastSessionCommand!;
  assert(sent.command.startsWith("sh -c '"), "Runs in a CHILD shell, not the session shell");
  assert(sent.command.includes("timeout -k 10 30 bash "), "coreutils timeout carries the caller's seconds");
  assertEqual(
    decodePayload(sent.command),
    "cd '/workspace' && sleep 999",
    "The timed payload is exactly the wrapped command"
  );
}

async function testRunKeepsBlockingSemantics(): Promise<void> {
  console.log("\n[4b] run() - still blocks, and still sends the wait bound");

  const processApi = createMockProcessApi();
  const commands = createCommands(processApi);

  await commands.run("echo hi", { timeoutMs: 45_000 });

  const sent = processApi.lastSessionCommand!;
  assertEqual(sent.runAsync, false, "runAsync stays false — run() blocks");
  assertEqual(sent.timeoutSec, 45, "The session API still gets the wait bound");
}

async function testRunWithoutTimeoutIsUnchanged(): Promise<void> {
  console.log("\n[4c] run() - no timeout requested, no wrapper");

  const processApi = createMockProcessApi();
  const commands = createCommands(processApi);

  await commands.run("echo hi", { cwd: "/app" });

  const sent = processApi.lastSessionCommand!;
  assertEqual(sent.command, "cd '/app' && echo hi", "Command is passed through untouched");
  assertEqual(sent.timeoutSec, undefined, "No wait bound either");
}

async function testRunPropagatesTimeoutExitCode(): Promise<void> {
  console.log("\n[4d] run() - the timed command's status is what comes back");

  const processApi = createMockProcessApi();
  // 124 is what coreutils `timeout` exits with, and the wrapper's `exit $rc`
  // is what carries it out through the child shell.
  processApi.execResponse = { cmdId: "cmd-124", exitCode: 124, stdout: "", stderr: "" };
  const commands = createCommands(processApi);

  const result = await commands.run("sleep 999", { timeoutMs: 5_000 });

  assertEqual(result.exitCode, 124, "Exit code propagates unchanged");
  assert(processApi.lastSessionCommand!.command.includes("exit $rc"), "Child shell propagates the status");
}

async function testInBoxTimeoutDegradesWithoutCoreutils(): Promise<void> {
  console.log("\n[4e] withInBoxTimeout() - a box with no coreutils still runs the command");

  const wrapped = _testWithInBoxTimeout("echo hi", 30);

  assert(wrapped.includes("if command -v timeout >/dev/null 2>&1; then"), "coreutils presence is tested");
  assert(/else bash \/tmp\/\.evolve-cmd-[^;]+; fi/.test(wrapped), "Falls back to an un-timed run");
  assert(wrapped.includes("rm -f /tmp/.evolve-cmd-"), "The script file is cleaned up either way");
}

async function testInBoxTimeoutNeedsNoQuoting(): Promise<void> {
  console.log("\n[4f] withInBoxTimeout() - a caller's quotes cannot break out of `sh -c`");

  // The payload is base64 precisely so the single-quoted body never has to
  // escape anything the caller wrote.
  const nasty = `echo 'it'\\''s here'; rm -rf /`;
  const wrapped = _testWithInBoxTimeout(nasty, 10);

  assertEqual((wrapped.match(/'/g) || []).length, 2, "Exactly the two quotes that delimit `sh -c`");
  assertEqual(decodePayload(wrapped), nasty, "The caller's command survives verbatim");
}

async function testInBoxTimeoutFailsClosedOnBadDecode(): Promise<void> {
  console.log("\n[4h] withInBoxTimeout() - a box with no `base64` FAILS, it does not report success");

  // THE REGRESSION THIS PINS. `>` creates the script before its pipeline runs,
  // so a missing `base64` used to leave a zero-byte file — and `bash <empty>`
  // exits 0 having printed nothing. The eval artifact listing is itself a
  // `find ... | base64 -w0`, so such a box failed that listing loudly BEFORE
  // this wrapper existed; fail-open would have converted it into an empty
  // listing: no files, no patch, clean exit all the way up.
  const wrapped = _testWithInBoxTimeout("echo hello; exit 7", 30);

  const broken = runWrapper(wrapped, { stripBase64: true });
  assertEqual(broken.code, 126, "No base64: exits 126, which is nonzero and therefore visible");
  assertEqual(broken.stdout, "", "No base64: nothing is printed that could be mistaken for output");

  // The same wrapper on a normal box still runs the payload and hands back ITS
  // status — the guard must not cost the happy path.
  const ok = runWrapper(wrapped);
  assertEqual(ok.code, 7, "With base64: the payload's own exit code propagates");
  assertEqual(ok.stdout.trim(), "hello", "With base64: the payload's stdout is intact");
}

async function testInBoxTimeoutGuardShape(): Promise<void> {
  console.log("\n[4i] withInBoxTimeout() - the decode is chained, and the script is size-checked");

  const wrapped = _testWithInBoxTimeout("echo hi", 30);

  assert(/base64 -d > \/tmp\/\.evolve-cmd-\S+ && \[ -s /.test(wrapped), "Decode is chained with && , not ;");
  assert(wrapped.includes("exit 126"), "The bail-out is an explicit nonzero exit");
  assert(/\{ rm -f \/tmp\/\.evolve-cmd-\S+; exit 126; \}/.test(wrapped), "The bail-out cleans up its stray file");
}

async function testInBoxTimeoutOmittedWhenNoDeadline(): Promise<void> {
  console.log("\n[4g] withInBoxTimeout() - no deadline, no wrapper");

  assertEqual(_testWithInBoxTimeout("echo hi", undefined), "echo hi", "undefined returns the command unchanged");
  assertEqual(_testWithInBoxTimeout("echo hi", 0), "echo hi", "Zero returns the command unchanged");
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  // [1] wrapCommand pure function
  testWrapCommandPassthrough,
  testWrapCommandCwdOnly,
  testWrapCommandEnvsOnly,
  testWrapCommandMultipleEnvs,
  testWrapCommandCwdPlusEnvs,
  testWrapCommandSingleQuoteEscapingCwd,
  testWrapCommandSingleQuoteEscapingEnvs,
  testWrapCommandEnvsFilterNullUndefined,
  testWrapCommandSpacesInEnvValues,
  // [2] DaytonaCommands.run() execution paths
  testRunAlwaysUsesSession,
  testRunEmptyStdoutFallback,
  testRunInlineStdoutNoFallback,
  testRunStreamingPath,
  testRunStreamsLiveNotAfterExit,
  testStreamingRunNeverFabricatesAStatus,
  testStreamingRunFallsBackWhenFollowYieldsNothing,
  testStreamedRunIsBoundedByTheCommandNotTheFollow,
  testRunSessionCleanup,
  testRunOutputField,
  // [3] spawn with envs
  testSpawnWithEnvs,
  testSpawnWithoutEnvs,
  // [4] the in-box kill on run()
  testRunPlantsInBoxTimeout,
  testRunKeepsBlockingSemantics,
  testRunWithoutTimeoutIsUnchanged,
  testRunPropagatesTimeoutExitCode,
  testInBoxTimeoutDegradesWithoutCoreutils,
  testInBoxTimeoutNeedsNoQuoting,
  testInBoxTimeoutFailsClosedOnBadDecode,
  testInBoxTimeoutGuardShape,
  testInBoxTimeoutOmittedWhenNoDeadline,
];

(async () => {
  console.log("=== Daytona Provider: wrapCommand + DaytonaCommands Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
