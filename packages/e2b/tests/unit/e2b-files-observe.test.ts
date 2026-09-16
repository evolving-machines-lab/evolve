#!/usr/bin/env tsx
/**
 * Unit Test: E2B live file observation (list/stat, watch, range reads, metrics, inspect).
 * Every vendor answer used as a fixture was recorded from a live sandbox on 2026-09-16 (lane L2 fold-2 e2e-e2b.json).
 * Usage: npx tsx tests/unit/e2b-files-observe.test.ts
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
  // envd's permission string is Go's FileMode.String(); its numeric mode carries no setuid/setgid/sticky bit.
  { name: "setuid", path: "/tmp/p/setuid", type: "file", size: 1, mode: 493, permissions: "urwxr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "both", path: "/tmp/p/both", type: "file", size: 1, mode: 493, permissions: "ugrwxr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "sgid", path: "/tmp/p/sgid", type: "dir", size: 60, mode: 493, permissions: "dgrwxr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "sticky", path: "/tmp/p/sticky", type: "dir", size: 60, mode: 511, permissions: "dtrwxrwxrwx", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "fifo", path: "/tmp/p/fifo", size: 0, mode: 420, permissions: "prw-r--r--", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "sock", path: "/tmp/p/sock", size: 0, mode: 493, permissions: "Srwxr-xr-x", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "null", path: "/dev/null", size: 0, mode: 438, permissions: "Dcrw-rw-rw-", owner: "root", group: "root", modifiedTime: MTIME },
  // envd's answer for `ln -s /nonexistent dangling` (getInfo, 2026-09-16): its own path as the target
  { name: "dangling", path: "/tmp/p/dangling", size: 12, mode: 0, permissions: "Lrwxrwxrwx", owner: "root", group: "root", modifiedTime: MTIME, symlinkTarget: "/tmp/p/dangling" },
  // chmod 000 / 010 entries and a chmod-000 directory (recorded on box iizah2kr4423bkps32l3m, 2026-09-16, fold-3 e2e-e2b-red.json)
  { name: "zero", path: "/tmp/p/zero", type: "file", size: 1, mode: 0, permissions: "----------", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "ten", path: "/tmp/p/ten", type: "file", size: 1, mode: 8, permissions: "------x---", owner: "root", group: "root", modifiedTime: MTIME },
  { name: "dzero", path: "/tmp/p/dzero", type: "dir", size: 60, mode: 0, permissions: "d---------", owner: "root", group: "root", modifiedTime: MTIME },
  // envd sends no modifiedTime for an mtime of 0: `touch -d @0 epoch` and the base template's /usr/bin/busybox (same box; REVIEW-2 box iy9vpb4j8bupv5nhedcpj too).
  { name: "epoch", path: "/tmp/p/epoch", type: "file", size: 1, mode: 420, permissions: "-rw-r--r--", owner: "root", group: "root" },
  { name: "busybox", path: "/usr/bin/busybox", type: "file", size: 1210176, mode: 493, permissions: "-rwxr-xr-x", owner: "root", group: "root" },
];

/** The sandbox record envd 0.6.10 answers (Sandbox.getInfo), the part the adapter reads. */
const INFO = { envdVersion: "0.6.10" };

async function testList(): Promise<void> {
  console.log("\n[1] list: the uniform entry, symlinks by the link's own bits, never by the target's type");
  const calls: unknown[] = [];
  let infoReads = 0;
  const files = new E2BFiles({ files: { list: async (path: string, opts: unknown) => { calls.push([path, opts]); return LIVE_ENTRIES; } }, getInfo: async () => { infoReads++; return INFO; } } as any, "root");
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
  assertEqual([byName["setuid"].mode, byName["both"].mode, byName["sgid"].mode, byName["sticky"].mode], ["4755", "6755", "2755", "1777"], "setuid, setgid and sticky come from the Go prefix letters (the numeric mode drops them)");
  assertEqual([byName["sgid"].type, byName["sticky"].type], ["dir", "dir"], "a directory with a special bit is still a dir");
  assertEqual([byName["fifo"].type, byName["sock"].type, byName["null"].type], ["other", "other", "other"], "a fifo, a socket and a device are 'other', never 'file'");
  assertEqual([byName["fifo"].mode, byName["null"].mode], ["0644", "0666"], "…with their own permission bits");
  assert(!("target" in byName["a.txt"]), "no target field on a non-link");
  assertEqual([byName["dangling"].type, "target" in byName["dangling"]], ["symlink", false], "a dangling link is a symlink whose target is left unset (envd reports its own path)");
  assertEqual([byName["zero"].mode, byName["ten"].mode, byName["dzero"].type, byName["dzero"].mode], ["0000", "0010", "dir", "0000"], "modes below 0100 come through the Go string as four digits");
  assertEqual([byName["epoch"].mtime, byName["busybox"].mtime], ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"], "an entry envd sends no modifiedTime for has an mtime of 0: the epoch, and the listing holds");
  await files.list("/tmp/p");
  assertEqual(infoReads, 1, "the envd version is read once per sandbox (Sandbox.getInfo), not per call");
  const missing = new E2BFiles({ files: { list: async () => { const err = new Error("[not_found] path not found: lstat /tmp/nope"); err.name = "FileNotFoundError"; throw err; } }, getInfo: async () => INFO } as any, "root");
  await rejects(() => missing.list("/tmp/nope"), "SandboxPathNotFoundError", "list on a missing directory is SandboxPathNotFoundError");
  const missingOld = new E2BFiles({ files: { list: async () => { const err = new Error("[not_found] path not found: lstat /tmp/nope"); err.name = "NotFoundError"; throw err; } }, getInfo: async () => INFO } as any, "root");
  await rejects(() => missingOld.list("/tmp/nope"), "SandboxPathNotFoundError", "e2b before 2.15.0 throws NotFoundError; still SandboxPathNotFoundError");
}

async function testStat(): Promise<void> {
  console.log("\n[2] stat: one entry, symlink reported as such; missing paths are typed not_found");
  const vendor = {
    files: {
      getInfo: async (path: string) => {
        if (path === "/tmp/p/link") return LIVE_ENTRIES[2];
        if (path === "/usr/bin/busybox") return LIVE_ENTRIES[LIVE_ENTRIES.length - 1];
        const err = new Error("[not_found] file not found: lstat /tmp/p/missing: no such file or directory");
        err.name = "FileNotFoundError";
        throw err;
      },
    },
  };
  const files = new E2BFiles({ ...vendor, getInfo: async () => INFO } as any, "root");
  const info = await files.stat("/tmp/p/link");
  assertEqual([info.type, info.target, info.mode], ["symlink", "/tmp/p/a.txt", "0777"], "stat on a symlink reports the link and its target");
  assertEqual((await files.stat("/usr/bin/busybox")).mtime, "1970-01-01T00:00:00.000Z", "stat on an entry with no modifiedTime is the epoch, not a refusal");
  const err = await rejects(() => files.stat("/tmp/p/missing"), "SandboxPathNotFoundError", "stat on a missing path is SandboxPathNotFoundError");
  assertEqual([(err as SandboxPathNotFoundError).path, (err as SandboxPathNotFoundError).provider], ["/tmp/p/missing", "e2b"], "not_found carries the path and the provider");
  const known = new E2BFiles({ ...vendor } as any, "root", "0.6.10");
  assertEqual((await known.stat("/tmp/p/link")).type, "symlink", "a sandbox whose envd version is already known (inspect) never reads the record");
}

async function testEnvdFloor(): Promise<void> {
  console.log("\n[2b] the envd floor: entry permissions, owner, group and mtime arrived in envd 0.2.5; older is a typed refusal on the sandbox's version, never on an entry");
  const old = new E2BFiles({ files: { list: async () => LIVE_ENTRIES, getInfo: async () => LIVE_ENTRIES[0] }, getInfo: async () => ({ envdVersion: "0.2.4" }) } as any, "root");
  const err = await rejects(() => old.list("/tmp/p"), "SandboxFeatureUnsupportedError", "list on envd 0.2.4 is refused typed");
  assertEqual([(err as SandboxFeatureUnsupportedError).feature, (err as SandboxFeatureUnsupportedError).provider], ["files.list", "e2b"], "…naming the feature and the provider");
  assert(String((err as Error).message).includes("0.2.4") && String((err as Error).message).includes("0.2.5"), "…and the sandbox's version and the floor");
  const err2 = await rejects(() => old.stat("/tmp/p/a.txt"), "SandboxFeatureUnsupportedError", "stat on envd 0.2.4 is refused typed");
  assertEqual((err2 as SandboxFeatureUnsupportedError).feature, "files.stat", "…naming files.stat, not files.list");
  const floor = new E2BFiles({ files: { list: async () => LIVE_ENTRIES } } as any, "root", "0.2.5");
  assertEqual((await floor.list("/tmp/p")).length, LIVE_ENTRIES.length, "envd 0.2.5 itself is accepted");
  const two = new E2BFiles({ files: { list: async () => LIVE_ENTRIES } } as any, "root", "0.10.0");
  assertEqual((await two.list("/tmp/p")).length, LIVE_ENTRIES.length, "versions compare numerically (0.10.0 is newer than 0.2.5)");
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
  await testEnvdFloor();
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
