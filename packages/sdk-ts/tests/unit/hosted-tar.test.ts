#!/usr/bin/env tsx
/**
 * Unit Test: tarGzipDirectoryToFile() — the published corpus's bytes
 *
 * The sha256 of the archive this writes IS the dataset version's source
 * identity on the server, so its byte layout is a contract, not an
 * implementation detail. It also decides what a published corpus CONTAINS —
 * a file the writer drops is a file the eval never sees.
 *
 * What this pins down:
 *   - determinism: the same directory tars to the same sha256, twice in a row,
 *     across mtime / permission / creation-order differences, AND across
 *     different output file names (nothing about the destination may reach
 *     the bytes — the Python twin once leaked the temp file's name into the
 *     gzip FNAME header field);
 *   - dotfiles are PACKED (.gitignore, .env.example, .config/) and only the
 *     three junk names (.git, .DS_Store, .venv) are skipped;
 *   - the executable bit survives (a verifier script arrives runnable) and is
 *     normalized to 0o755 / 0o644 so a umask cannot move the digest;
 *   - every other header field is flattened: mtime 0, uid/gid 0, empty
 *     uname/gname, and the gzip header carries no timestamp;
 *   - symlinks never enter the archive (the server rejects them);
 *   - names longer than a USTAR name field still pack;
 *   - the corpus streams off disk AND the archive streams to disk — neither
 *     is ever held whole in memory (the F1 incident: the old Buffer path
 *     cost ~10x a corpus's size in RSS);
 *   - the size-guarded Buffer wrapper (tarGzipDirectory, kept only for the
 *     sandbox skill mount) returns the same bytes and refuses past its cap;
 *   - an empty directory is valid bytes and a missing one rejects;
 *   - a mixed corpus — incompressible blobs beside text — still unpacks
 *     bit-exact and deterministically (the gzip member is SEGMENTED: stored
 *     blocks for entries that sample incompressible, deflate for the rest);
 *   - an incompressible corpus packs several-fold faster than deflating it
 *     at level 9 — the law the segmentation exists for (a 7.7 GB corpus of
 *     already-compressed blobs once spent ~14 minutes recompressing for ~2%);
 *   - the crc32 fallback used where native zlib.crc32 is absent (Node
 *     < 20.15 / 22.2, inside the documented "Node.js 18+" floor) produces
 *     the exact zlib values, so the gzip trailer is right on every
 *     supported runtime.
 *
 * Usage:
 *   npm run test:unit:hosted-tar
 *   npx tsx tests/unit/hosted-tar.test.ts
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib, { gunzipSync, gzipSync } from "node:zlib";
import { extract } from "tar-stream";

import { crc32Fallback, shouldStore, tarGzipDirectory, tarGzipDirectoryToFile } from "../../src/hosted/tar.ts";

/** Pack via the streaming engine and read the archive back for inspection. */
async function pack(root: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "hosted-tar-out-"));
  try {
    const out = join(dir, "archive.tar.gz");
    await tarGzipDirectoryToFile(root, out);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// TEST HELPERS
// =============================================================================

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
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (expected ${b}, got ${a})`);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Unpacked {
  name: string;
  mode: number;
  mtime: number;
  uid: number;
  gid: number;
  uname: string;
  gname: string;
  content: Buffer;
}

/** Read the archive back through tar-stream, header fields and all. */
async function unpack(gzipped: Buffer): Promise<Unpacked[]> {
  const out: Unpacked[] = [];
  const ex = extract();
  const done = (async () => {
    for await (const entry of ex) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(Buffer.from(chunk));
      const h = entry.header;
      out.push({
        name: h.name,
        mode: h.mode ?? 0,
        mtime: h.mtime instanceof Date ? h.mtime.getTime() : 0,
        uid: h.uid ?? 0,
        gid: h.gid ?? 0,
        uname: h.uname ?? "",
        gname: h.gname ?? "",
        content: Buffer.concat(chunks),
      });
    }
  })();
  ex.end(gunzipSync(gzipped));
  await done;
  return out;
}

/** Make a fresh fixture directory and hand its path to `build`. */
function fixture(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "hosted-tar-"));
  build(root);
  return root;
}

function write(root: string, rel: string, content: string, mode?: number): void {
  const abs = join(root, rel);
  const dir = abs.slice(0, abs.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, content);
  if (mode !== undefined) chmodSync(abs, mode);
}

// =============================================================================
// TESTS
// =============================================================================

/** The same directory tarred twice is the same bytes — the digest contract. */
async function testDeterministicAcrossRuns(): Promise<void> {
  console.log("\n[1] Determinism — two runs, one sha256");
  const root = fixture((r) => {
    write(r, "task.toml", "id = 'one'\n");
    write(r, "tests/verify.py", "assert True\n");
    write(r, "solution/solve.sh", "#!/bin/sh\nexit 0\n", 0o755);
    write(r, ".gitignore", "__pycache__/\n");
  });
  try {
    const a = await pack(root);
    const b = await pack(root);
    assertEqual(sha256(a), sha256(b), "two runs over one directory produce one sha256");
    assert(a.length > 0, "the archive is not empty");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Machine state must not reach the bytes: mtime, umask, creation order. */
async function testDeterministicAcrossMachineState(): Promise<void> {
  console.log("\n[2] Determinism — machine state cannot move the digest");

  // Same content, opposite creation order: the walk sorts, so the bytes match.
  const forward = fixture((r) => {
    write(r, "a.txt", "a\n");
    write(r, "b.txt", "b\n");
    write(r, "z/nested.txt", "n\n");
  });
  const reverse = fixture((r) => {
    write(r, "z/nested.txt", "n\n");
    write(r, "b.txt", "b\n");
    write(r, "a.txt", "a\n");
  });
  try {
    assertEqual(
      sha256(await pack(forward)),
      sha256(await pack(reverse)),
      "creation order does not change the bytes",
    );
  } finally {
    rmSync(forward, { recursive: true, force: true });
    rmSync(reverse, { recursive: true, force: true });
  }

  // Touching a file must not move the digest — mtime is pinned to 0.
  const touched = fixture((r) => write(r, "a.txt", "a\n"));
  try {
    const before = sha256(await pack(touched));
    utimesSync(join(touched, "a.txt"), new Date(1e9), new Date(1e9));
    assertEqual(sha256(await pack(touched)), before, "a changed mtime does not change the bytes");
  } finally {
    rmSync(touched, { recursive: true, force: true });
  }

  // 0o600 and 0o644 are both "not executable" — one archive, one digest.
  const tight = fixture((r) => write(r, "a.txt", "a\n", 0o600));
  const loose = fixture((r) => write(r, "a.txt", "a\n", 0o644));
  try {
    assertEqual(
      sha256(await pack(tight)),
      sha256(await pack(loose)),
      "a stricter umask does not change the bytes",
    );
  } finally {
    rmSync(tight, { recursive: true, force: true });
    rmSync(loose, { recursive: true, force: true });
  }
}

/** Dotfiles are corpus content. Only the three junk names are dropped. */
async function testDotfilesArePacked(): Promise<void> {
  console.log("\n[3] Dotfiles are packed, junk is not");
  const root = fixture((r) => {
    write(r, "task.toml", "id = 'one'\n");
    write(r, ".gitignore", "__pycache__/\n");
    write(r, ".dockerignore", ".git\n");
    write(r, ".env.example", "API_KEY=\n");
    write(r, ".config/settings.json", "{}\n");
    write(r, "nested/.hidden-rc", "x\n");
    write(r, ".git/config", "[core]\n");
    write(r, ".venv/pyvenv.cfg", "home = /usr\n");
    write(r, ".DS_Store", "junk");
    write(r, "nested/.DS_Store", "junk");
  });
  try {
    const names = (await unpack(await pack(root))).map((e) => e.name);
    assertEqual(
      names,
      [".config/settings.json", ".dockerignore", ".env.example", ".gitignore", "nested/.hidden-rc", "task.toml"],
      "every dotfile but the three junk names is packed, in sorted order",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A verifier script has to arrive runnable. */
async function testExecutableBitSurvives(): Promise<void> {
  console.log("\n[4] The executable bit survives, normalized");
  const root = fixture((r) => {
    write(r, "run.sh", "#!/bin/sh\nexit 0\n", 0o755);
    write(r, "odd.sh", "#!/bin/sh\nexit 0\n", 0o711);
    write(r, "notes.md", "hello\n", 0o644);
    write(r, "tight.md", "hello\n", 0o600);
  });
  try {
    const byName = new Map((await unpack(await pack(root))).map((e) => [e.name, e]));
    assertEqual(byName.get("run.sh")?.mode, 0o755, "an executable file keeps +x (0o755)");
    assertEqual(byName.get("odd.sh")?.mode, 0o755, "an odd executable mode normalizes to 0o755");
    assertEqual(byName.get("notes.md")?.mode, 0o644, "a plain file is 0o644");
    assertEqual(byName.get("tight.md")?.mode, 0o644, "a 0o600 file normalizes to 0o644");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Every field that could carry machine identity is flattened. */
async function testHeadersAreFlattened(): Promise<void> {
  console.log("\n[5] Headers carry no machine identity");
  const root = fixture((r) => write(r, "a.txt", "a\n"));
  try {
    const gzipped = await pack(root);
    const [entry] = await unpack(gzipped);
    assertEqual(entry.mtime, 0, "mtime is 0");
    assertEqual(entry.uid, 0, "uid is 0");
    assertEqual(entry.gid, 0, "gid is 0");
    assertEqual(entry.uname, "", "uname is empty");
    assertEqual(entry.gname, "", "gname is empty");
    // Bytes 4..8 of a gzip member are its MTIME field.
    assertEqual(gzipped.readUInt32LE(4), 0, "the gzip header carries no timestamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The server rejects any non-file entry, so symlinks never leave the client. */
async function testSymlinksAreSkipped(): Promise<void> {
  console.log("\n[6] Symlinks never enter the archive");
  const root = fixture((r) => {
    write(r, "real.txt", "real\n");
    write(r, "dir/inner.txt", "inner\n");
  });
  symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
  symlinkSync(join(root, "dir"), join(root, "dirlink"));
  try {
    const names = (await unpack(await pack(root))).map((e) => e.name);
    assertEqual(names, ["dir/inner.txt", "real.txt"], "neither a file symlink nor a directory symlink is packed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A long path packs instead of throwing, and stays deterministic. */
async function testLongPaths(): Promise<void> {
  console.log("\n[7] Long paths pack");
  const long = `${"d".repeat(120)}/${"f".repeat(120)}.txt`;
  const root = fixture((r) => write(r, long, "deep\n"));
  try {
    const a = await pack(root);
    const b = await pack(root);
    const entries = await unpack(a);
    assertEqual(entries.map((e) => e.name), [long], "a 245-byte path round-trips under its own name");
    assertEqual(entries[0]?.content.toString("utf8"), "deep\n", "its content round-trips");
    assertEqual(sha256(a), sha256(b), "a long path is still deterministic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Neither side of the pack is ever whole in memory: the corpus streams off
 * disk INTO the pack, and the compressed archive streams OUT to the file.
 * Incompressible content makes the output side as heavy as the input side,
 * so the sampler bounds BOTH — this is the F1 fence at the packer level
 * (the old Buffer-collecting path held the whole archive).
 */
async function testStreamsFromDisk(): Promise<void> {
  console.log("\n[8] The corpus streams off disk and the archive streams to disk");
  const MB = 1024 * 1024;
  const SIZE = 64 * MB;
  // Incompressible-ish: a deterministic byte mix gzip cannot flatten, so the
  // large archive would show in `arrayBuffers` if the writer collected it.
  // Written a chunk at a time, so the test itself never holds the file.
  const chunk = Buffer.alloc(4 * MB);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + ((i >> 9) * 131)) & 0xff;
  const root = fixture((r) => {
    const fd = openSync(join(r, "big.bin"), "w");
    try {
      for (let written = 0; written < SIZE; written += chunk.length) writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
  });
  const outDir = mkdtempSync(join(tmpdir(), "hosted-tar-stream-"));
  try {
    // Sample memory still HELD, not read-buffer garbage that has not been
    // swept yet. The suite runs this file with --expose-gc for exactly this.
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) {
      failed++;
      console.log("  ✗ this test needs --expose-gc (npm run test:unit:hosted-tar)");
      return;
    }
    gc();
    const base = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const sampler = setInterval(() => {
      gc();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
    }, 20);
    const out = join(outDir, "big.tar.gz");
    try {
      await tarGzipDirectoryToFile(root, out);
    } finally {
      clearInterval(sampler);
    }
    assert(peak < 8 * MB, `held bytes stay far under the 64MB corpus+archive (peak ${(peak / MB).toFixed(1)}MB)`);
    const entries = await unpack(readFileSync(out));
    assertEqual(entries.length, 1, "the large file packs as one entry");
    assertEqual(entries[0]?.content.length, SIZE, "the large file round-trips at full length");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * The destination must never reach the bytes: two different output paths,
 * one digest. Pinned because the Python twin's gzip writer embedded the
 * (random) temp file's name in the gzip FNAME header field the moment it
 * got a real file object — moving the server-side source identity per run.
 */
async function testOutputNameNeverReachesTheBytes(): Promise<void> {
  console.log("\n[8b] The output file name never reaches the bytes");
  const root = fixture((r) => write(r, "a.txt", "a\n"));
  const outDir = mkdtempSync(join(tmpdir(), "hosted-tar-names-"));
  try {
    const one = join(outDir, "first-name.tar.gz");
    const two = join(outDir, "a-completely-different-name.tar.gz");
    await tarGzipDirectoryToFile(root, one);
    await tarGzipDirectoryToFile(root, two);
    assertEqual(
      sha256(readFileSync(one)),
      sha256(readFileSync(two)),
      "two output names, one sha256"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * The Buffer wrapper exists for ONE caller (the sandbox skill mount, whose
 * provider write seam takes bytes). It must return exactly the streamed
 * engine's bytes, and refuse past its size cap instead of degrading into
 * the incident it replaced.
 */
async function testBufferWrapper(): Promise<void> {
  console.log("\n[8c] The size-guarded Buffer wrapper");
  const root = fixture((r) => {
    write(r, "SKILL.md", "# skill\n");
    write(r, "run.sh", "#!/bin/sh\nexit 0\n", 0o755);
  });
  try {
    const viaWrapper = await tarGzipDirectory(root);
    const viaEngine = await pack(root);
    assertEqual(sha256(viaWrapper), sha256(viaEngine), "wrapper bytes === engine bytes");

    // The guard: a cap below the archive size refuses with the measured size.
    let threw = false;
    try {
      await tarGzipDirectory(root, 16);
    } catch (e) {
      threw = true;
      assert(
        (e as Error).message.includes("16-byte cap"),
        "the refusal names the cap it enforces"
      );
    }
    assert(threw, "an archive over the cap refuses instead of returning a Buffer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** An empty directory produces a valid, empty archive rather than throwing. */
async function testEmptyDirectory(): Promise<void> {
  console.log("\n[9] An empty directory is a valid empty archive");
  const root = fixture(() => {});
  try {
    const gzipped = await pack(root);
    assertEqual((await unpack(gzipped)).length, 0, "no entries");
    assertEqual(gunzipSync(gzipped).length, 1024, "two zero blocks = end of archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A corpus mixing incompressible blobs with text crosses every segment
 * boundary the writer has — archive opens stored, switches to deflate,
 * switches back, and closes stored (names are chosen so the sort puts a
 * blob first and last). Everything must still unpack bit-exact through a
 * plain gunzip, and the digest must not move between runs.
 */
async function testMixedCorpusRoundTrips(): Promise<void> {
  console.log("\n[11] A mixed corpus round-trips across segment switches");
  const MB = 1024 * 1024;
  // Deterministic incompressible-looking bytes; odd length exercises the
  // final partial stored block.
  const blob = Buffer.allocUnsafe(3 * MB + 12345);
  for (let i = 0; i < blob.length; i += 4) {
    blob.writeUInt32LE(Math.imul(i ^ 0x9e3779b9, 2654435761) >>> 0, Math.min(i, blob.length - 4));
  }
  const text = Buffer.from("a compressible line of corpus text\n".repeat(60000)); // ~2MB
  const root = fixture((r) => {
    write(r, "task.toml", "id = 'mixed'\n");
    write(r, "tests/verify.py", "assert True\n");
  });
  writeFileSync(join(root, "aaa-first.bin"), blob);
  writeFileSync(join(root, "notes.md"), text);
  writeFileSync(join(root, "zzz-last.bin"), blob);
  try {
    // The premise every switch below stands on, asserted so a fixture change
    // can never hollow this test into an all-deflate archive without failing
    // loudly (the Python twin's fixture once rotted exactly that way).
    assert(await shouldStore(join(root, "aaa-first.bin"), blob.length), "premise: the blob samples incompressible (rides STORED)");
    assert(await shouldStore(join(root, "zzz-last.bin"), blob.length), "premise: the blob samples incompressible (rides STORED)");
    assert(!(await shouldStore(join(root, "notes.md"), text.length)), "premise: the text samples compressible (rides DEFLATE)");
    const a = await pack(root);
    const b = await pack(root);
    assertEqual(sha256(a), sha256(b), "a mixed corpus is still deterministic");
    const byName = new Map((await unpack(a)).map((e) => [e.name, e]));
    assertEqual(
      [...byName.keys()].length,
      5,
      "all five entries arrive"
    );
    assert(byName.get("aaa-first.bin")!.content.equals(blob), "a stored entry at the archive's head round-trips bit-exact");
    assert(byName.get("zzz-last.bin")!.content.equals(blob), "a stored entry at the archive's tail round-trips bit-exact");
    assert(byName.get("notes.md")!.content.equals(text), "a deflated entry between them round-trips bit-exact");
    // Smaller than its raw content: the blobs ride ~1:1, so only a working
    // deflate segment can make up the difference.
    assert(a.length < 2 * blob.length + text.length, "the deflate segment still compresses the text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The law the segmented member exists for: a corpus that cannot compress is
 * PACKED, not recompressed. Measured relative to deflating the same bytes at
 * level 9 in the same process, so machine speed cancels out; the stored path
 * runs ~10x faster than the deflate path, and the old always-deflate engine
 * sat at ~1x — the halfway bound is far from both.
 */
async function testIncompressibleCorpusPacksFast(): Promise<void> {
  console.log("\n[12] An incompressible corpus packs without recompression");
  const MB = 1024 * 1024;
  const blob = randomBytes(32 * MB);
  const root = fixture((r) => write(r, "task.toml", "id = 'blob'\n"));
  writeFileSync(join(root, "weights.bin"), blob);
  const outDir = mkdtempSync(join(tmpdir(), "hosted-tar-fast-"));
  try {
    const t9 = performance.now();
    gzipSync(blob, { level: 9 });
    const deflateMs = performance.now() - t9;

    const t = performance.now();
    await tarGzipDirectoryToFile(root, join(outDir, "blob.tar.gz"));
    const packMs = performance.now() - t;

    assert(
      packMs * 2 < deflateMs,
      `packing 32MB of incompressible bytes beats half a level-9 deflate of them ` +
        `(pack ${packMs.toFixed(0)}ms vs deflate ${deflateMs.toFixed(0)}ms)`
    );
    const entries = await unpack(readFileSync(join(outDir, "blob.tar.gz")));
    assert(
      entries.find((e) => e.name === "weights.bin")!.content.equals(blob),
      "the stored blob round-trips bit-exact"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * The trailer checksum on runtimes without native `zlib.crc32` (absent on
 * Node < 20.15 / 22.2 — inside the README's "Node.js 18+" floor): the
 * fallback must produce the exact zlib values, running-value argument
 * included, or an archive packed on an older runtime carries a trailer no
 * gunzip accepts. Pinned two ways: known-answer vectors that hold on every
 * runtime, and bit-equality against the native function where it exists.
 */
function testCrc32FallbackMatchesNative(): void {
  console.log("\n[13] The crc32 fallback matches native zlib.crc32");
  assertEqual(crc32Fallback(Buffer.from("123456789")), 0xcbf43926, 'crc32("123456789") is the standard check value');
  assertEqual(crc32Fallback(Buffer.alloc(0)), 0, "crc32 of nothing is 0");
  // A split checksum equals the one-shot checksum — the writer feeds the
  // trailer crc block by block through the running-value argument.
  const data = randomBytes(256 * 1024);
  const split = crc32Fallback(data.subarray(7777), crc32Fallback(data.subarray(0, 7777)));
  assertEqual(split, crc32Fallback(data), "a chained crc equals the one-shot crc");
  const native: ((data: Uint8Array, value?: number) => number) | undefined = zlib.crc32;
  if (native !== undefined) {
    assertEqual(crc32Fallback(data), native(data), "fallback equals native on random bytes");
    assertEqual(split, native(data.subarray(7777), native(data.subarray(0, 7777))), "fallback equals native with a running value");
  } else {
    console.log("  (no native zlib.crc32 on this runtime — known-answer vectors above are the pin)");
  }
}

/** A directory that is not there rejects; it never resolves to empty bytes. */
async function testMissingDirectoryRejects(): Promise<void> {
  console.log("\n[10] A missing directory rejects");
  const root = fixture(() => {});
  rmSync(root, { recursive: true, force: true });
  try {
    await pack(root);
    failed++;
    console.log("  ✗ a missing directory rejects (it resolved instead)");
  } catch (e) {
    assert((e as NodeJS.ErrnoException).code === "ENOENT", "a missing directory rejects with ENOENT");
  }
}

// =============================================================================
// RUNNER
// =============================================================================

async function main(): Promise<void> {
  console.log("tarGzipDirectoryToFile() — the published corpus's bytes\n" + "=".repeat(60));

  await testDeterministicAcrossRuns();
  await testDeterministicAcrossMachineState();
  await testDotfilesArePacked();
  await testExecutableBitSurvives();
  await testHeadersAreFlattened();
  await testSymlinksAreSkipped();
  await testLongPaths();
  await testStreamsFromDisk();
  await testOutputNameNeverReachesTheBytes();
  await testBufferWrapper();
  await testEmptyDirectory();
  await testMissingDirectoryRejects();
  await testMixedCorpusRoundTrips();
  await testIncompressibleCorpusPacksFast();
  testCrc32FallbackMatchesNative();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
