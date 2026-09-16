#!/usr/bin/env tsx
/**
 * Unit Test: Daytona live file observation (find-based list/stat, typed watch refusal, range reads, metrics, inspect).
 * Fixtures are the vendor answers recorded on a live sandbox on 2026-09-16.
 * Usage: npx tsx tests/unit/daytona-files-observe.test.ts
 */

import {
  DaytonaFiles,
  DaytonaProvider,
  _testDaytonaSandboxImplCtor,
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

/** One find record per entry: type, size, mtime, octal mode, owner, group, link target, name — NUL-terminated. */
function records(rows: string[][]): string {
  return rows.map((r) => r.join("\0") + "\0").join("");
}
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

function fakeRunner(reply: (command: string) => { exitCode: number; stdout: string; stderr: string }) {
  const commands: string[] = [];
  return {
    commands,
    run: async (command: string) => { commands.push(command); return reply(command); },
  };
}

const LIVE_LISTING = records([
  ["f", "5", "1789591683.7105480630", "644", "daytona", "daytona", "", "a.txt"],
  ["l", "12", "1789591683.7105480630", "777", "daytona", "daytona", "/nonexistent", "dangling"],
  ["l", "3", "1789591683.7105480630", "777", "daytona", "daytona", "sub", "dirlink"],
  ["f", "1", "1789591683.7125480470", "644", "daytona", "daytona", "", "sp ace.txt"],
  ["d", "4096", "1789591683.7105480630", "755", "daytona", "daytona", "", "sub"],
  ["s", "0", "1789591683.0000000000", "755", "root", "root", "", "sock"],
  ["f", "1", "1789591683.0000000000", "4755", "root", "root", "", "setuid"],
  // find prints %m unpadded: chmod 000 → "0", chmod 010 → "10", a chmod-000 directory → "0"; touch -d @0 → %T@ "0.0000000000"
  // (the product's own find record, recorded on box 111caa7f-5fbc-421b-b471-db04370abe63, 2026-09-16, fold-3 e2e-daytona-red.json).
  ["f", "1", "1789599834.6186756830", "0", "root", "root", "", "zero"],
  ["f", "1", "1789599834.6196236450", "10", "root", "root", "", "ten"],
  ["d", "6", "1789599834.6213716710", "0", "root", "root", "", "dzero"],
  ["f", "1", "0.0000000000", "644", "root", "root", "", "epoch"],
]);

async function testList(): Promise<void> {
  console.log("\n[1] list: one read-only find, NUL-framed, base64 on the wire; every entry lstat-true");
  const runner = fakeRunner(() => ({ exitCode: 0, stdout: b64(LIVE_LISTING + "STATUS:0"), stderr: "" }));
  const files = new DaytonaFiles({} as any, runner as any);
  const entries = await files.list("/tmp/p");
  assert(runner.commands[0].includes("find -H '/tmp/p' -mindepth 1 -maxdepth 1 -printf"), `the command is a bounded, non-recursive find on the quoted path (${runner.commands[0].slice(0, 80)}…)`);
  assert(runner.commands[0].includes("base64") && runner.commands[0].includes("STATUS:"), "the listing rides base64 so no byte of a name is decoded by a text channel");
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assertEqual(byName["a.txt"], { name: "a.txt", path: "/tmp/p/a.txt", type: "file", size: 5, mtime: "2026-09-16T20:48:03.710Z", mode: "0644", owner: "daytona", group: "daytona" }, "a regular file: ISO mtime from %T@, 4-digit octal mode, owner/group by name");
  assertEqual([byName["dirlink"].type, byName["dirlink"].target, byName["dirlink"].mode], ["symlink", "sub", "0777"], "a symlink to a directory is a symlink with its target");
  assertEqual([byName["dangling"].type, byName["dangling"].target], ["symlink", "/nonexistent"], "a dangling symlink is listed (the daemon's own list would drop it)");
  assertEqual(byName["sp ace.txt"].size, 1, "whitespace names survive the NUL framing");
  assertEqual(byName["sock"].type, "other", "a socket is 'other'");
  assertEqual(byName["setuid"].mode, "4755", "setuid stays in the mode");
  assertEqual([byName["zero"].mode, byName["ten"].mode, byName["dzero"].type, byName["dzero"].mode], ["0000", "0010", "dir", "0000"], "modes below 0100 (find prints them as '0' and '10') are four-digit modes, and the listing holds");
  assertEqual(byName["epoch"].mtime, "1970-01-01T00:00:00.000Z", "an mtime of 0 is the epoch");
  assertEqual(entries.length, 11, "every record is an entry");
  const empty = new DaytonaFiles({} as any, fakeRunner(() => ({ exitCode: 0, stdout: b64("STATUS:0"), stderr: "" })) as any);
  assertEqual(await empty.list("/tmp/empty"), [], "an empty directory is an empty list");
}

async function testListRefusals(): Promise<void> {
  console.log("\n[2] list refusals: not_found, not a directory, and an image without GNU find are all typed");
  const nf = new DaytonaFiles({} as any, fakeRunner(() => ({ exitCode: 2, stdout: "", stderr: "" })) as any);
  const err = await rejects(() => nf.list("/tmp/missing"), "SandboxPathNotFoundError", "a missing path is SandboxPathNotFoundError");
  assertEqual([(err as SandboxPathNotFoundError).path, (err as SandboxPathNotFoundError).provider], ["/tmp/missing", "daytona"], "…carrying path and provider");
  const nd = new DaytonaFiles({} as any, fakeRunner(() => ({ exitCode: 20, stdout: "", stderr: "" })) as any);
  const e2 = await rejects(() => nd.list("/tmp/p/a.txt"), "Error", "a file path is refused");
  assert(String((e2 as Error).message).includes("not a directory"), "…saying it is not a directory");
  const bb = new DaytonaFiles({} as any, fakeRunner(() => ({ exitCode: 0, stdout: b64("STATUS:1"), stderr: "find: unrecognized: -printf" })) as any);
  const e3 = await rejects(() => bb.list("/tmp/p"), "SandboxFeatureUnsupportedError", "an image whose find has no -printf is a typed refusal");
  assertEqual([(e3 as SandboxFeatureUnsupportedError).feature, (e3 as SandboxFeatureUnsupportedError).provider], ["files.list", "daytona"], "…naming the feature and the provider");
}

async function testStat(): Promise<void> {
  console.log("\n[3] stat: the path itself (never followed), typed not_found");
  const runner = fakeRunner((cmd) => cmd.includes("'/tmp/p/link'")
    ? { exitCode: 0, stdout: b64(records([["l", "5", "1789591683.7105480630", "777", "daytona", "daytona", "a.txt", "link"]]) + "STATUS:0"), stderr: "" }
    : { exitCode: 2, stdout: "", stderr: "" });
  const files = new DaytonaFiles({} as any, runner as any);
  const info = await files.stat("/tmp/p/link");
  assertEqual(info, { name: "link", path: "/tmp/p/link", type: "symlink", size: 5, mtime: "2026-09-16T20:48:03.710Z", mode: "0777", owner: "daytona", group: "daytona", target: "a.txt" }, "a symlink stats as a symlink with its target");
  assert(runner.commands[0].includes("-maxdepth 0") && !runner.commands[0].includes("find -H"), "stat looks at the path itself and does not follow it");
  await rejects(() => files.stat("/tmp/p/missing"), "SandboxPathNotFoundError", "a missing path is SandboxPathNotFoundError");
}

function fetchStub(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; range: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, range: new Headers(init?.headers).get("range") });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

async function testReadRange(): Promise<void> {
  console.log("\n[4] readRange: a Range request on the sandbox's signed download URL");
  const body = Uint8Array.from({ length: 100 }, (_, i) => i);
  const urls: string[] = [];
  const files = new DaytonaFiles({ downloadUrl: async (path: string) => { urls.push(path); return `https://toolbox.example/files/download?path=${encodeURIComponent(path)}`; } } as any, fakeRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })) as any);
  let stub = fetchStub((_url, init) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get("range")!)!;
    return new Response(body.subarray(Number(a), Number(b) + 1), { status: 206 });
  });
  try {
    const bytes = await files.readRange("/tmp/p/big.bin", { offset: 90, length: 5 });
    assertEqual(stub.seen[0].range, "bytes=90-94", "asks for exactly the requested bytes");
    assertEqual(Array.from(bytes), [90, 91, 92, 93, 94], "byte-exact");
    assertEqual(urls, ["/tmp/p/big.bin"], "the URL is minted for the path");
  } finally { stub.restore(); }
  stub = fetchStub(() => new Response("nope", { status: 404 }));
  try {
    await rejects(() => files.readRange("/tmp/p/missing", { offset: 0, length: 1 }), "SandboxPathNotFoundError", "404 is SandboxPathNotFoundError");
  } finally { stub.restore(); }
}

async function testWatchRefusal(): Promise<void> {
  console.log("\n[5] watchDir: a typed refusal naming the provider and the feature (no watcher in the SDK)");
  const files = new DaytonaFiles({} as any, fakeRunner(() => ({ exitCode: 0, stdout: "", stderr: "" })) as any);
  const err = await rejects(() => files.watchDir("/tmp/p", () => {}, { recursive: true }), "SandboxFeatureUnsupportedError", "watchDir refuses typed");
  assertEqual([(err as SandboxFeatureUnsupportedError).feature, (err as SandboxFeatureUnsupportedError).provider], ["files.watchDir", "daytona"], "…with feature and provider");
  assert(String((err as Error).message).includes("poll"), "…and tells the caller to poll list()");
}

async function testMetrics(): Promise<void> {
  console.log("\n[6] metrics: getMetricsLatest mapped to MiB, source named");
  const impl = new _testDaytonaSandboxImplCtor({
    id: "sb-1",
    getMetricsLatest: async () => ({ cpuCount: 1, cpuUsedPct: 12.5, diskTotal: 3221225472, diskUsed: 24576, memTotal: 1073741824, memUsed: 36552704, memCache: 16384, timestamp: new Date("2026-09-16T20:48:05.000Z") }),
  } as any);
  const m = await impl.metrics();
  assertEqual(m, { cpuPct: 12.5, memUsedMb: 36552704 / 1048576, memTotalMb: 1024, diskUsedMb: 24576 / 1048576, sampledAt: "2026-09-16T20:48:05.000Z", source: "daytona:getMetricsLatest" }, "the sample as the daemon reported it, bytes divided by 1 MiB, no rounding");
}

async function testInspect(): Promise<void> {
  console.log("\n[7] inspect: reads the sandbox record and refuses anything not started — never start()");
  const started: string[] = [];
  class Probe extends DaytonaProvider {
    protected async getSandboxRecord(sandboxId: string) {
      return {
        id: sandboxId,
        state: sandboxId === "stopped-one" ? "stopped" : "started",
        start: async () => { started.push(sandboxId); },
      } as any;
    }
  }
  const provider = new Probe({ apiKey: "k" });
  const err = await rejects(() => provider.inspect("stopped-one"), "SandboxNotRunningError", "a stopped sandbox is refused typed");
  assertEqual([(err as SandboxNotRunningError).sandboxId, (err as SandboxNotRunningError).provider, (err as SandboxNotRunningError).state], ["stopped-one", "daytona", "stopped"], "…naming id, provider and state");
  const sb = await provider.inspect("live-one");
  assertEqual(sb.sandboxId, "live-one", "a started sandbox attaches");
  assertEqual(started, [], "start() was never called");
}

(async () => {
  await testList();
  await testListRefusals();
  await testStat();
  await testReadRange();
  await testWatchRefusal();
  await testMetrics();
  await testInspect();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
