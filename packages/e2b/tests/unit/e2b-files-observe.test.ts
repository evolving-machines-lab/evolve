#!/usr/bin/env tsx
/**
 * Unit Test: E2B live file observation — list/stat entry shape, watch event
 * normalization, byte-exact range reads over a signed URL, metrics, and the
 * inspect-only attach that never touches the sandbox's lifetime.
 *
 * Every vendor answer used here was recorded from a live sandbox on
 * 2026-09-16 (lane L2 probe): envd lists a symlink with the TARGET's type and
 * the link's own permission string ("Lrwxrwxrwx"), drops a dangling link,
 * reports watch names relative to the watched directory, answers a `Range`
 * request on the signed download URL with 206, and returns no metrics sample
 * for the first seconds of a sandbox's life.
 *
 * Usage:
 *   npx tsx tests/unit/e2b-files-observe.test.ts
 */

import {
  E2BFiles,
  E2BProvider,
  _testE2BSandboxImplCtor,
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

const MTIME = new Date("2026-09-16T20:47:59.627Z");

/** Entries exactly as envd 0.6.10 returned them on 2026-09-16. */
const LIVE_ENTRIES = [
  { name: "a.txt", path: "/tmp/p/a.txt", type: "file", size: 5, mode: 420, permissions: "-rw-r--r--", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "dirlink", path: "/tmp/p/dirlink", type: "dir", size: 3, mode: 493, permissions: "Lrwxrwxrwx", owner: "root", group: "root", modifiedTime: MTIME, symlinkTarget: "/tmp/p/sub" },
  { name: "link", path: "/tmp/p/link", type: "file", size: 5, mode: 420, permissions: "Lrwxrwxrwx", owner: "root", group: "root", modifiedTime: MTIME, symlinkTarget: "/tmp/p/a.txt" },
  { name: "sp ace.txt", path: "/tmp/p/sp ace.txt", type: "file", size: 1, mode: 420, permissions: "-rw-r--r--", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "sub", path: "/tmp/p/sub", type: "dir", size: 4096, mode: 493, permissions: "drwxr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "setuid", path: "/tmp/p/setuid", type: "file", size: 1, mode: 2541, permissions: "-rwsr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "sock", path: "/tmp/p/sock", size: 0, mode: 420, permissions: "Srwxr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  // envd's answer for `ln -s /nonexistent dangling` (getInfo, 2026-09-16): its own path as the target
  { name: "dangling", path: "/tmp/p/dangling", size: 12, mode: 0, permissions: "Lrwxrwxrwx", owner: "root", group: "root", modifiedTime: MTIME, symlinkTarget: "/tmp/p/dangling" },
];

async function testList(): Promise<void> {
  console.log("\n[1] list: the uniform entry, symlinks by the link's own bits, never by the target's type");
  const calls: unknown[] = [];
  const files = new E2BFiles({ files: { list: async (path: string, opts: unknown) => { calls.push([path, opts]); return LIVE_ENTRIES; } } } as any, "root");
  const entries = await files.list("/tmp/p");
  assertEqual(calls[0], ["/tmp/p", { user: "root" }], "lists through the vendor API as the configured user");
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assertEqual(byName["a.txt"], { name: "a.txt", path: "/tmp/p/a.txt", type: "file", size: 5, mtime: "2026-09-16T20:47:59.627Z", mode: "0644", owner: "root", group: "root" }, "a regular file: octal mode from the permission string, ISO mtime");
  assertEqual(byName["link"].type, "symlink", "a symlink is a symlink even though envd typed it 'file'");
  assertEqual(byName["link"].target, "/tmp/p/a.txt", "the symlink carries its target");
  assertEqual(byName["link"].mode, "0777", "the symlink's mode is the LINK's (from 'Lrwxrwxrwx'), not the target's 0644");
  assertEqual(byName["dirlink"].type, "symlink", "a symlink to a directory is a symlink, not a dir");
  assertEqual(byName["sub"].type, "dir", "a directory is a dir");
  assertEqual(byName["sp ace.txt"].name, "sp ace.txt", "whitespace names survive");
  assertEqual(byName["setuid"].mode, "4755", "setuid bit is kept in the octal mode");
  assertEqual(byName["sock"].type, "other", "an entry envd gives no type for is 'other', never 'file'");
  assert(!("target" in byName["a.txt"]), "no target field on a non-link");
  assertEqual([byName["dangling"].type, "target" in byName["dangling"]], ["symlink", false], "a dangling link is a symlink whose target is left unset (envd reports its own path)");
  const missing = new E2BFiles({ files: { list: async () => { const err = new Error("[not_found] path not found: lstat /tmp/nope"); err.name = "FileNotFoundError"; throw err; } } } as any, "root");
  await rejects(() => missing.list("/tmp/nope"), "SandboxPathNotFoundError", "list on a missing directory is SandboxPathNotFoundError");
}

async function testStat(): Promise<void> {
  console.log("\n[2] stat: one entry, symlink reported as such; missing paths are typed not_found");
  const files = new E2BFiles({
    files: {
      getInfo: async (path: string) => {
        if (path === "/tmp/p/link") return LIVE_ENTRIES[2];
        const err = new Error("[not_found] file not found: lstat /tmp/p/missing: no such file or directory");
        err.name = "FileNotFoundError";
        throw err;
      },
    },
  } as any, "root");
  const info = await files.stat("/tmp/p/link");
  assertEqual([info.type, info.target, info.mode], ["symlink", "/tmp/p/a.txt", "0777"], "stat on a symlink reports the link and its target");
  const err = await rejects(() => files.stat("/tmp/p/missing"), "SandboxPathNotFoundError", "stat on a missing path is SandboxPathNotFoundError");
  assertEqual([(err as SandboxPathNotFoundError).path, (err as SandboxPathNotFoundError).provider], ["/tmp/p/missing", "e2b"], "not_found carries the path and the provider");
}

function fetchStub(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; range: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, range: headers.get("range") });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

async function testReadRange(): Promise<void> {
  console.log("\n[3] readRange: a Range request on the signed download URL, byte-exact, every status typed");
  const body = Uint8Array.from({ length: 100 }, (_, i) => i);
  const urls: unknown[] = [];
  const files = new E2BFiles({ downloadUrl: async (path: string, opts: unknown) => { urls.push([path, opts]); return `https://envd.example/files?path=${encodeURIComponent(path)}`; } } as any, "root");

  let stub = fetchStub((_url, init) => {
    const range = new Headers(init.headers).get("range")!;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
    return new Response(body.subarray(Number(a), Number(b) + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/100` } });
  });
  try {
    const bytes = await files.readRange("/tmp/p/big.bin", { offset: 10, length: 10 });
    assertEqual(stub.seen[0].range, "bytes=10-19", "asks for exactly the requested bytes");
    assertEqual(Array.from(bytes), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], "returns the exact bytes of the range");
    assert(bytes instanceof Uint8Array, "bytes come back as a Uint8Array");
    assertEqual((urls[0] as unknown[])[0], "/tmp/p/big.bin", "the signed URL is minted for the requested path");
    const empty = await files.readRange("/tmp/p/big.bin", { offset: 10, length: 0 });
    assertEqual(empty.length, 0, "a zero-length range returns no bytes without a request");
    assertEqual(stub.seen.length, 1, "…and made no second request");
  } finally { stub.restore(); }

  stub = fetchStub(() => new Response(body, { status: 200 }));
  try {
    const bytes = await files.readRange("/tmp/p/big.bin", { offset: 95, length: 10 });
    assertEqual(Array.from(bytes), [95, 96, 97, 98, 99], "a server that ignores Range still yields the exact slice, shortened at EOF");
  } finally { stub.restore(); }

  stub = fetchStub(() => new Response("", { status: 416 }));
  try {
    const bytes = await files.readRange("/tmp/p/big.bin", { offset: 1000, length: 10 });
    assertEqual(bytes.length, 0, "a range past EOF (416) is an empty read, not an error");
  } finally { stub.restore(); }

  stub = fetchStub(() => new Response("nope", { status: 404 }));
  try {
    await rejects(() => files.readRange("/tmp/p/missing", { offset: 0, length: 1 }), "SandboxPathNotFoundError", "404 is SandboxPathNotFoundError");
  } finally { stub.restore(); }

  stub = fetchStub(() => new Response("boom", { status: 500 }));
  try {
    await rejects(() => files.readRange("/tmp/p/big.bin", { offset: 0, length: 1 }), "Error", "other statuses surface as an Error naming the status");
  } finally { stub.restore(); }

  await rejects(() => files.readRange("/tmp/p/big.bin", { offset: -1, length: 1 }), "RangeError", "a negative offset is refused before any request");
  await rejects(() => files.readRange("/tmp/p/big.bin", { offset: 0.5, length: 1 }), "RangeError", "a fractional offset is refused");
}

async function testWatch(): Promise<void> {
  console.log("\n[4] watchDir: native recursive watch with no timeout, events as absolute paths in the 4-word vocabulary");
  let captured: { path: string; onEvent: (e: unknown) => void; opts: Record<string, unknown> } | undefined;
  let stopped = 0;
  const files = new E2BFiles({
    files: {
      watchDir: async (path: string, onEvent: (e: unknown) => void, opts: Record<string, unknown>) => {
        captured = { path, onEvent, opts };
        return { stop: async () => { stopped++; } };
      },
    },
  } as any, "root");
  const got: unknown[] = [];
  const handle = await files.watchDir("/tmp/p", (ev) => { got.push(ev); }, { recursive: true });
  assertEqual([captured!.opts.recursive, captured!.opts.timeoutMs, captured!.opts.user], [true, 0, "root"], "recursive is forwarded, the vendor's 60 s default timeout is switched off, the user is set");
  for (const ev of [
    { name: "sub/b.txt", type: "create" },
    { name: "sub/b.txt", type: "write" },
    { name: "sub/b.txt", type: "chmod" },
    { name: "sub/b.txt", type: "rename" },
    { name: "sub/c.txt", type: "remove" },
  ]) captured!.onEvent(ev);
  assertEqual(got, [
    { path: "/tmp/p/sub/b.txt", type: "create" },
    { path: "/tmp/p/sub/b.txt", type: "write" },
    { path: "/tmp/p/sub/b.txt", type: "write" },
    { path: "/tmp/p/sub/b.txt", type: "rename" },
    { path: "/tmp/p/sub/c.txt", type: "remove" },
  ], "names become absolute paths under the watched dir; chmod is reported as an in-place write");
  await handle.stop();
  assertEqual(stopped, 1, "stop() stops the vendor watch");
  const unrec = await files.watchDir("/tmp/p/", (ev) => { got.push(ev); }, {});
  assertEqual(captured!.opts.recursive, false, "recursive defaults to false (the vendor's own default)");
  captured!.onEvent({ name: "x", type: "create" });
  assertEqual(got[got.length - 1], { path: "/tmp/p/x", type: "create" }, "a trailing slash on the watched dir does not double up");
  await unrec.stop();
  const missing = new E2BFiles({ files: { watchDir: async () => { const err = new Error("[not_found] path /tmp/nope not found"); err.name = "FileNotFoundError"; throw err; } } } as any, "root");
  await rejects(() => missing.watchDir("/tmp/nope", () => {}, {}), "SandboxPathNotFoundError", "a watch on a missing directory is SandboxPathNotFoundError");
}

async function testMetrics(): Promise<void> {
  console.log("\n[5] metrics: the newest vendor sample, or null while there is none yet");
  const calls: unknown[] = [];
  const samples: Array<Record<string, unknown>> = [];
  const impl = new _testE2BSandboxImplCtor({
    sandboxId: "sb-1",
    getMetrics: async (opts: unknown) => { calls.push(opts); return samples; },
  } as any, "key");
  assertEqual(await impl.metrics(), null, "no sample yet is null, never zeros");
  const t1 = new Date("2026-09-16T20:48:10.000Z");
  const t2 = new Date("2026-09-16T20:48:15.000Z");
  samples.push(
    { timestamp: t2, cpuUsedPct: 7.5, cpuCount: 2, memUsed: 3 * 1048576, memTotal: 1024 * 1048576, memCache: 0, diskUsed: 512 * 1048576, diskTotal: 10240 * 1048576 },
    { timestamp: t1, cpuUsedPct: 1, cpuCount: 2, memUsed: 1048576, memTotal: 1024 * 1048576, memCache: 0, diskUsed: 0, diskTotal: 0 },
  );
  const m = await impl.metrics();
  assertEqual(m, { cpuPct: 7.5, memUsedMb: 3, memTotalMb: 1024, diskUsedMb: 512, sampledAt: "2026-09-16T20:48:15.000Z", source: "e2b:getMetrics" }, "the newest sample by timestamp, bytes as MiB, source named");
  await impl.metrics();
  assertEqual((calls[2] as { start?: Date }).start?.toISOString(), t2.toISOString(), "later calls ask only from the last sample onward");
  assertEqual((calls[0] as { start?: Date }).start, undefined, "the first call asks for everything");
}

async function testInspect(): Promise<void> {
  console.log("\n[6] inspect: attaches by a read of the sandbox record, never by the connect call that resets the lifetime");
  const seen: string[] = [];
  class Probe extends E2BProvider {
    protected async fetchSandboxDetail(sandboxId: string) {
      seen.push(sandboxId);
      if (sandboxId === "paused-one") return { sandboxID: sandboxId, state: "paused", envdVersion: "0.6.10", domain: "e2b.app", envdAccessToken: "t" } as any;
      return { sandboxID: sandboxId, state: "running", envdVersion: "0.6.10", domain: "e2b.app", envdAccessToken: "t" } as any;
    }
  }
  const provider = new Probe({ apiKey: "k" });
  const err = await rejects(() => provider.inspect("paused-one"), "SandboxNotRunningError", "a paused sandbox is refused typed (connect would have resumed it)");
  assertEqual([(err as SandboxNotRunningError).sandboxId, (err as SandboxNotRunningError).provider, (err as SandboxNotRunningError).state], ["paused-one", "e2b", "paused"], "the refusal names the sandbox, the provider and the state");
  const sb = await provider.inspect("live-one");
  assertEqual(sb.sandboxId, "live-one", "a running sandbox attaches");
  assertEqual(seen, ["paused-one", "live-one"], "one record read per inspect");
  assert(typeof sb.files.stat === "function" && typeof sb.files.readRange === "function" && typeof sb.metrics === "function", "the attached instance carries the observation surface");
}

async function testUnsupportedIsTyped(): Promise<void> {
  console.log("\n[7] the typed-refusal class is the shared one");
  const err = new SandboxFeatureUnsupportedError("x", "e2b");
  assertEqual(err.name, "SandboxFeatureUnsupportedError", "exported from the package");
}

(async () => {
  await testList();
  await testStat();
  await testReadRange();
  await testWatch();
  await testMetrics();
  await testInspect();
  await testUnsupportedIsTyped();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
