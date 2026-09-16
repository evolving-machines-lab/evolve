#!/usr/bin/env tsx
/**
 * Unit Test: the sandbox observation errors — one home, three declared
 * mirrors, matched by NAME across package boundaries.
 *
 * The provider packages cannot import @evolvingmachines/sdk (the SDK depends
 * on them; build order is providers → sdk), so the one class each of them
 * throws for an unsupported capability is a GENERATED copy of
 * packages/sdk-ts/src/sandbox-errors.ts. This test is the forcing function
 * that keeps the copies byte-equal to the source, and pins the name-based
 * matching that lets a caller recognise a mirror's instance without a shared
 * prototype.
 *
 * Usage:
 *   npx tsx tests/unit/sandbox-errors.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SandboxFeatureUnsupportedError,
  SandboxNotRunningError,
  SandboxPathNotFoundError,
  isSandboxFeatureUnsupportedError,
  isSandboxNotRunningError,
  isSandboxPathNotFoundError,
} from "../../src/sandbox-errors";
import { SANDBOX_ERRORS_SOURCE, SANDBOX_ERRORS_MIRRORS, SANDBOX_MIRROR_SETS } from "../../../../scripts/generate-sandbox-errors";
import { assertByteRange, isoTime, joinPath, octalMode, readByteRangeOverUrl } from "../../src/sandbox-observation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");

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

console.log("\n[1] typed refusals carry the feature, the provider and the reason");
{
  const err = new SandboxFeatureUnsupportedError("files.watchDir", "daytona", "the SDK has no watcher");
  assert(err.name === "SandboxFeatureUnsupportedError", "name is the class name");
  assert(err.feature === "files.watchDir" && err.provider === "daytona", "feature and provider are fields");
  assert(err.message.includes("daytona") && err.message.includes("files.watchDir") && err.message.includes("no watcher"), "message names all three");
  assert(err instanceof Error, "is an Error");
  const bare = new SandboxFeatureUnsupportedError("metrics", "modal");
  assert(bare.message === "modal does not support metrics", "message without a reason is the plain sentence");
}

console.log("\n[2] not-found and not-running are typed too");
{
  const nf = new SandboxPathNotFoundError("/app/missing", "e2b");
  assert(nf.name === "SandboxPathNotFoundError" && nf.path === "/app/missing" && nf.provider === "e2b", "not-found carries path and provider");
  const nr = new SandboxNotRunningError("sb-1", "daytona", "stopped");
  assert(nr.name === "SandboxNotRunningError" && nr.sandboxId === "sb-1" && nr.state === "stopped", "not-running carries id and state");
  assert(nr.message.includes("stopped") && nr.message.includes("sb-1"), "not-running message names the state");
}

console.log("\n[3] guards match by NAME, so a mirror's instance is recognised without a shared prototype");
{
  const foreign = Object.assign(new Error("modal does not support metrics"), {
    name: "SandboxFeatureUnsupportedError",
    feature: "metrics",
    provider: "modal",
  });
  assert(isSandboxFeatureUnsupportedError(foreign), "a same-named foreign error is recognised");
  assert(!isSandboxFeatureUnsupportedError(new Error("x")), "a plain Error is not");
  assert(!isSandboxFeatureUnsupportedError(null), "null is not");
  assert(isSandboxPathNotFoundError(Object.assign(new Error("nf"), { name: "SandboxPathNotFoundError", path: "/x", provider: "e2b" })), "not-found guard matches by name");
  assert(isSandboxNotRunningError(Object.assign(new Error("nr"), { name: "SandboxNotRunningError", sandboxId: "s", provider: "e2b", state: "paused" })), "not-running guard matches by name");
}

console.log("\n[4] every provider mirror is byte-equal to its source (npm run generate:sandbox-errors)");
{
  assert(SANDBOX_ERRORS_SOURCE.endsWith("sandbox-errors.ts") && SANDBOX_ERRORS_MIRRORS.length === 3, "the errors file has three mirrors declared (e2b, daytona, modal)");
  assert(SANDBOX_MIRROR_SETS.length === 2, "two mirrored files: the errors and the observation rules");
  for (const { source, mirrors } of SANDBOX_MIRROR_SETS) {
    const text = readFileSync(resolve(REPO_ROOT, source), "utf-8");
    for (const mirror of mirrors) {
      let copy = "";
      try {
        copy = readFileSync(resolve(REPO_ROOT, mirror), "utf-8");
      } catch {
        copy = "";
      }
      assert(copy === text, `${mirror} equals ${source}`);
    }
  }
}

console.log("\n[5] the shared observation rules: mode strings, timestamps, ranges");
{
  assert(octalMode(420) === "0644" && octalMode(33188) === "0644" && octalMode(41471) === "0777", "numeric st_mode → permission bits only, four digits");
  assert(octalMode("644") === "0644" && octalMode("0755") === "0755", "bare or padded octal strings are padded");
  assert(octalMode("-rw-r--r--") === "0644" && octalMode("Lrwxrwxrwx") === "0777" && octalMode("drwxr-xr-x") === "0755", "ls-style strings, with a type character, are read as bits");
  assert(octalMode("-rwsr-xr-x") === "4755" && octalMode("rwxrwsr-x") === "2775" && octalMode("rwxrwxrwt") === "1777" && octalMode("rwSr--r--") === "4644", "setuid / setgid / sticky, executable or not");
  let threw = false;
  try { octalMode("nonsense"); } catch (e) { threw = e instanceof RangeError; }
  assert(threw, "a string that is neither octal nor a permission string is refused");
  assert(isoTime(new Date("2026-09-16T20:47:59.627Z")) === "2026-09-16T20:47:59.627Z", "a Date passes through");
  assert(isoTime(1789591686) === "2026-09-16T20:48:06.000Z", "epoch seconds become ISO");
  assert(isoTime(1789591683.710548063) === "2026-09-16T20:48:03.710Z", "fractional epoch seconds keep milliseconds");
  assert(isoTime("2026-09-16T20:48:03.710548063Z") === "2026-09-16T20:48:03.710Z", "an RFC 3339 string with nanoseconds is normalised to milliseconds");
  assert(joinPath("/tmp/p", "a") === "/tmp/p/a" && joinPath("/tmp/p/", "a") === "/tmp/p/a", "joinPath never doubles a slash");
  for (const bad of [{ offset: -1, length: 1 }, { offset: 0.5, length: 1 }, { offset: 0, length: -1 }, { offset: 0, length: Number.NaN }]) {
    let refused = false;
    try { assertByteRange(bad); } catch (e) { refused = e instanceof RangeError; }
    assert(refused, `range ${JSON.stringify(bad)} is refused`);
  }
}

console.log("\n[6] readByteRangeOverUrl: every status has one meaning");
{
  const body = Uint8Array.from({ length: 50 }, (_, i) => i);
  const original = globalThis.fetch;
  const withFetch = async (handler: (init: RequestInit) => Response, run: () => Promise<void>) => {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => handler(init ?? {})) as typeof fetch;
    try { await run(); } finally { globalThis.fetch = original; }
  };
  const ctx = { provider: "test", path: "/f", timeoutMs: 1000 };
  await withFetch((init) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get("range")!)!;
    return new Response(body.subarray(Number(a), Number(b) + 1), { status: 206 });
  }, async () => {
    const got = await readByteRangeOverUrl("u", { offset: 40, length: 20 }, ctx);
    assert(Array.from(got).join(",") === "40,41,42,43,44,45,46,47,48,49", "206: the bytes, shortened at EOF");
  });
  await withFetch(() => new Response(body, { status: 200 }), async () => {
    const got = await readByteRangeOverUrl("u", { offset: 45, length: 3 }, ctx);
    assert(Array.from(got).join(",") === "45,46,47", "200: the slice is cut out of the whole-file stream");
  });
  await withFetch(() => new Response("", { status: 416 }), async () => {
    assert((await readByteRangeOverUrl("u", { offset: 99, length: 3 }, ctx)).length === 0, "416: empty");
  });
  await withFetch(() => new Response("", { status: 404 }), async () => {
    let name = "";
    try { await readByteRangeOverUrl("u", { offset: 0, length: 3 }, ctx); } catch (e) { name = (e as Error).name; }
    assert(name === "SandboxPathNotFoundError", "404: SandboxPathNotFoundError");
  });
  await withFetch(() => new Response("", { status: 503 }), async () => {
    let msg = "";
    try { await readByteRangeOverUrl("u", { offset: 0, length: 3 }, ctx); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("503") && msg.includes("/f"), "other statuses: an Error naming the status and the path");
  });
  let requests = 0;
  await withFetch(() => { requests++; return new Response("", { status: 206 }); }, async () => {
    assert((await readByteRangeOverUrl("u", { offset: 0, length: 0 }, ctx)).length === 0 && requests === 0, "a zero-length range makes no request");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
