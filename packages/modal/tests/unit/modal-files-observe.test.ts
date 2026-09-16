#!/usr/bin/env tsx
/**
 * Unit Test: Modal live file observation (native list/stat/watch, range reads, metrics refusal, stoppable readers,
 * inspect, typed refusals). Fixtures are the vendor answers recorded on a live sandbox on 2026-09-16.
 * Usage: npx tsx tests/unit/modal-files-observe.test.ts
 */

import {
  ModalCommands,
  ModalFiles,
  ModalProvider,
  _testModalSandboxImplCtor,
  SandboxFeatureUnsupportedError,
  SandboxNotRunningError,
  SandboxPathNotFoundError,
} from "../../src/index.ts";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

async function rejects(fn: () => Promise<unknown>, name: string, message: string): Promise<unknown> {
  try {
    await fn();
    assert(false, `${message} (did not throw)`);
    return undefined;
  } catch (err) {
    assert((err as Error).name === name, `${message} (got ${(err as Error).name}: ${(err as Error).message})`);
    return err;
  }
}

/** Entries exactly as modal@0.9.0's listFiles returned them on 2026-09-16. */
const LIVE_ENTRIES = [
  { name: "a.txt", path: "/tmp/p/a.txt", type: "file", size: 5, mode: 33188, permissions: "0644", owner: "root", group: "root", modifiedTime: 1789591686, symlinkTarget: null },
  { name: "dangling", path: "/tmp/p/dangling", type: "symlink", size: 12, mode: 41471, permissions: "0777", owner: "root", group: "root", modifiedTime: 1789591686, symlinkTarget: "/nonexistent" },
  { name: "link", path: "/tmp/p/link", type: "symlink", size: 5, mode: 41471, permissions: "0777", owner: "root", group: "root", modifiedTime: 1789591686, symlinkTarget: "a.txt" },
  { name: "sp ace.txt", path: "/tmp/p/sp ace.txt", type: "file", size: 1, mode: 33188, permissions: "0644", owner: "root", group: "root", modifiedTime: 1789591686, symlinkTarget: null },
  { name: "sub", path: "/tmp/p/sub", type: "directory", size: 4096, mode: 16877, permissions: "0755", owner: "root", group: "root", modifiedTime: 1789591686, symlinkTarget: null },
  { name: "sock", path: "/tmp/p/sock", type: "socket", size: 0, mode: 49645, permissions: "0755", owner: "root", group: "root", modifiedTime: 1789591686, symlinkTarget: null },
];

function notFound(path: string): Error {
  const err = new Error(`path does not exist: ${path}`);
  err.name = "SandboxFilesystemNotFoundError";
  return err;
}

async function testListAndStat(): Promise<void> {
  console.log("\n[1] list/stat: the native filesystem API, uniform entry, no text parsing");
  const calls: string[] = [];
  const files = new ModalFiles({
    filesystem: {
      listFiles: async (path: string) => { calls.push(`list ${path}`); if (path === "/tmp/missing") throw notFound(path); return LIVE_ENTRIES; },
      stat: async (path: string) => { calls.push(`stat ${path}`); if (path === "/tmp/p/missing") throw notFound(path); return LIVE_ENTRIES[2]; },
    },
    exec: async () => { throw new Error("list must not exec ls"); },
  } as any, "root");
  const entries = await files.list("/tmp/p");
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assertEqual(byName["a.txt"], { name: "a.txt", path: "/tmp/p/a.txt", type: "file", size: 5, mtime: "2026-09-16T20:48:06.000Z", mode: "0644", owner: "root", group: "root" }, "a regular file: epoch seconds become ISO, the permission string is the octal mode");
  assertEqual([byName["link"].type, byName["link"].target], ["symlink", "a.txt"], "a symlink with its target as written");
  assertEqual([byName["dangling"].type, byName["dangling"].target], ["symlink", "/nonexistent"], "a dangling symlink is listed");
  assertEqual(byName["sub"].type, "dir", "'directory' becomes 'dir'");
  assertEqual(byName["sock"].type, "other", "a socket is 'other'");
  assertEqual(byName["sp ace.txt"].name, "sp ace.txt", "whitespace names survive (the ls parser split on them)");
  const info = await files.stat("/tmp/p/link");
  assertEqual([info.type, info.target, info.mode], ["symlink", "a.txt", "0777"], "stat reports the link itself");
  const err = await rejects(() => files.stat("/tmp/p/missing"), "SandboxPathNotFoundError", "a missing path is SandboxPathNotFoundError");
  assertEqual([(err as SandboxPathNotFoundError).path, (err as SandboxPathNotFoundError).provider], ["/tmp/p/missing", "modal"], "…with path and provider");
  await rejects(() => files.list("/tmp/missing"), "SandboxPathNotFoundError", "list on a missing directory is SandboxPathNotFoundError");
  assertEqual(calls, ["list /tmp/p", "stat /tmp/p/link", "stat /tmp/p/missing", "list /tmp/missing"], "one vendor call per operation");
}

function fakeProcess(stdoutBytes: Uint8Array, exitCode: number, stderrText = "") {
  let stdinClosed = false;
  return {
    stdinClosed: () => stdinClosed,
    process: {
      stdout: { readBytes: async () => stdoutBytes, readText: async () => new TextDecoder().decode(stdoutBytes), [Symbol.asyncIterator]: async function* () { yield new TextDecoder().decode(stdoutBytes); } },
      stderr: { readBytes: async () => new TextEncoder().encode(stderrText), readText: async () => stderrText, [Symbol.asyncIterator]: async function* () { if (stderrText) yield stderrText; } },
      stdin: { getWriter: () => ({ close: async () => { stdinClosed = true; }, write: async () => {}, releaseLock: () => {} }) },
      closeStdin: async () => { stdinClosed = true; },
      wait: async () => exitCode,
    },
  };
}

async function testReadRange(): Promise<void> {
  console.log("\n[2] readRange: a bounded tail|head in binary mode, byte-exact, typed refusals by exit code");
  const execs: Array<{ args: string[]; params: Record<string, unknown> }> = [];
  const body = Uint8Array.from([7, 8, 9]);
  let exit = 0;
  const files = new ModalFiles({
    exec: async (args: string[], params: Record<string, unknown>) => { execs.push({ args, params }); return fakeProcess(body, exit).process; },
  } as any, "root");
  const bytes = await files.readRange("/tmp/p/big.bin", { offset: 10, length: 3 });
  assertEqual(Array.from(bytes), [7, 8, 9], "the process's stdout bytes are the answer");
  assertEqual(execs[0].args.slice(0, 2), ["bash", "-c"], "runs through bash -c (pipefail)");
  assert(execs[0].args[2].includes("PIPESTATUS") && execs[0].args[2].includes("-eq 141") && execs[0].args[2].includes("tail -c +11") && execs[0].args[2].includes("head -c 3") && execs[0].args[2].includes("'/tmp/p/big.bin'"), `both pipeline statuses read, tail's SIGPIPE (141) accepted, tail starts at byte offset+1 and head bounds the length (${execs[0].args[2]})`);
  assertEqual(execs[0].params.mode, "binary", "binary mode: no text decoding on the way out");
  const empty = await files.readRange("/tmp/p/big.bin", { offset: 10, length: 0 });
  assertEqual([empty.length, execs.length], [0, 1], "a zero-length range makes no exec");
  exit = 2;
  await rejects(() => files.readRange("/tmp/p/missing", { offset: 0, length: 1 }), "SandboxPathNotFoundError", "exit 2 (the pre-check's not-found code) is SandboxPathNotFoundError");
  exit = 21;
  const e = await rejects(() => files.readRange("/tmp/p/sub", { offset: 0, length: 1 }), "Error", "a directory is refused");
  assert(String((e as Error).message).includes("directory"), "…saying so");
  await rejects(() => files.readRange("/tmp/p/big.bin", { offset: -1, length: 1 }), "RangeError", "a negative offset is refused before any exec");
}

async function testWatch(): Promise<void> {
  console.log("\n[3] watchDir: native watch, Access filtered at the source, events mapped to create/write/remove/rename");
  let params: Record<string, unknown> | undefined;
  const raw = [
    { eventType: "Create", paths: ["/tmp/p/sub/b.txt"] },
    { eventType: "Modify", paths: ["/tmp/p/sub/b.txt"] },
    { eventType: "Modify", paths: ["/tmp/p/sub/b.txt", "/tmp/p/sub/c.txt"] },
    { eventType: "Remove", paths: ["/tmp/p/sub/c.txt"] },
    { eventType: "Unknown", paths: ["/tmp/p/x"] },
  ];
  let released = false;
  const files = new ModalFiles({
    filesystem: {
      stat: async () => LIVE_ENTRIES[4],
      watch: (_path: string, p: Record<string, unknown>) => {
        params = p;
        return (async function* () {
          try {
            for (const ev of raw) yield ev;
            await new Promise(() => {}); // an idle watch: blocks until the consumer returns
          } finally {
            released = true;
          }
        })();
      },
    },
  } as any, "root");
  const got: unknown[] = [];
  const handle = await files.watchDir("/tmp/p", (ev) => { got.push(ev); }, { recursive: true });
  await new Promise((r) => setTimeout(r, 20));
  assertEqual(params?.recursive, true, "recursive is forwarded");
  assertEqual([...(params?.filter as string[])].sort(), ["Create", "Modify", "Remove"], "Access is filtered at the source; only the three change kinds are asked for");
  assertEqual(got, [
    { path: "/tmp/p/sub/b.txt", type: "create" },
    { path: "/tmp/p/sub/b.txt", type: "write" },
    { path: "/tmp/p/sub/b.txt", type: "rename" },
    { path: "/tmp/p/sub/c.txt", type: "rename" },
    { path: "/tmp/p/sub/c.txt", type: "remove" },
  ], "Create→create, one-path Modify→write, two-path Modify→rename for both paths, Remove→remove, Unknown dropped");
  const t = Date.now();
  await handle.stop();
  assert(Date.now() - t < 500, "stop() returns promptly even while the vendor iterator is idle");
  assertEqual(released, false, "…the vendor iterator is released at its next event, not before (documented Modal limit)");
  got.length = 0;
}

async function testMetricsRefusal(): Promise<void> {
  console.log("\n[4] metrics: a typed refusal naming the provider and the measured reason");
  const impl = new _testModalSandboxImplCtor({ sandboxId: "sb-1" } as any, undefined, "root");
  const err = await rejects(() => impl.metrics(), "SandboxFeatureUnsupportedError", "metrics refuses typed");
  assertEqual([(err as SandboxFeatureUnsupportedError).feature, (err as SandboxFeatureUnsupportedError).provider], ["metrics", "modal"], "…naming the feature and the provider");
  assert(String((err as Error).message).includes("/proc"), "…and the reason (host-wide /proc figures)");
}

async function testReaderStop(): Promise<void> {
  console.log("\n[5] spawn with stdin:false: the process is wrapped so closing the exec's stdin ends it; kill() is that close");
  const execs: string[][] = [];
  let proc = fakeProcess(new Uint8Array(), 143);
  const commands = new ModalCommands({ exec: async (args: string[]) => { execs.push(args); return proc.process; } } as any, "root");
  const handle = await commands.spawn("tail -F /var/log/x", { stdin: false });
  assertEqual(execs[0].slice(0, 2), ["bash", "-c"], "the reader runs under a bash wrapper");
  assert(execs[0][2].includes("exec 3<&0") && execs[0][2].includes("cat <&3 >/dev/null") && execs[0][2].includes('exec "$@" </dev/null'), `the watcher reads the exec's real stdin on fd 3 (a background job's own stdin is /dev/null) and the command is exec'd with /dev/null (${execs[0][2]})`);
  assertEqual(execs[0].slice(3), ["bash", "bash", "-c", "tail -F /var/log/x"], "the command follows as the wrapper's arguments, root runs it through bash -c");
  const killed = await handle.kill();
  assertEqual([killed, proc.stdinClosed()], [true, true], "kill() closes stdin and reports true");
  assertEqual((await handle.wait()).exitCode, 143, "the exit code is the signal's (128+15)");

  proc = fakeProcess(new Uint8Array(), 0);
  const plain = await commands.spawn("sleep 1000", {});
  assertEqual(execs[1].slice(0, 2), ["bash", "-c"], "without stdin:false the spawn is unchanged (no wrapper)");
  const err = await rejects(() => plain.kill(), "SandboxFeatureUnsupportedError", "kill() on such a spawn is a typed refusal");
  assertEqual([(err as SandboxFeatureUnsupportedError).feature, (err as SandboxFeatureUnsupportedError).provider], ["commands.kill", "modal"], "…naming commands.kill and modal");
  assert(String((err as Error).message).includes("stdin: false"), "…and how to get a stoppable process");
}

async function testInspect(): Promise<void> {
  console.log("\n[6] inspect: attaches to the sandbox id and refuses one that has exited");
  class Probe extends ModalProvider {
    protected async attachSandbox(sandboxId: string) {
      return { sandboxId, poll: async () => (sandboxId === "dead-one" ? 137 : null) } as any;
    }
  }
  const provider = new Probe({ tokenId: "id", tokenSecret: "secret" });
  const err = await rejects(() => provider.inspect("dead-one"), "SandboxNotRunningError", "an exited sandbox is refused typed");
  assertEqual([(err as SandboxNotRunningError).sandboxId, (err as SandboxNotRunningError).provider, (err as SandboxNotRunningError).state], ["dead-one", "modal", "exited with code 137"], "…naming id, provider and the exit");
  const sb = await provider.inspect("live-one");
  assertEqual(sb.sandboxId, "live-one", "a running sandbox attaches");
}

async function testMigratedRefusals(): Promise<void> {
  console.log("\n[7] every former bare 'Modal does not support' throw is the shared typed refusal");
  const commands = new ModalCommands({} as any, "root");
  const files = new ModalFiles({} as any, "root");
  for (const [label, fn, feature] of [
    ["commands.connect", () => commands.connect("1"), "commands.connect"],
    ["commands.sendStdin", () => commands.sendStdin("1", "x"), "commands.sendStdin"],
    ["files.uploadUrl", () => files.uploadUrl("/x"), "files.uploadUrl"],
    ["files.downloadUrl", () => files.downloadUrl("/x"), "files.downloadUrl"],
  ] as const) {
    const err = await rejects(fn as () => Promise<unknown>, "SandboxFeatureUnsupportedError", `${label} refuses typed`);
    assertEqual([(err as SandboxFeatureUnsupportedError).feature, (err as SandboxFeatureUnsupportedError).provider], [feature, "modal"], `…naming ${feature} and modal`);
  }
}

(async () => {
  await testListAndStat();
  await testReadRange();
  await testWatch();
  await testMetricsRefusal();
  await testReaderStop();
  await testInspect();
  await testMigratedRefusals();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
