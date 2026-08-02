#!/usr/bin/env tsx
/**
 * Unit Test: tarGzipDirectory() — the published corpus's bytes
 *
 * The sha256 of what this function returns IS the dataset version's source
 * identity on the server, so its byte layout is a contract, not an
 * implementation detail. It also decides what a published corpus CONTAINS —
 * a file the writer drops is a file the eval never sees.
 *
 * What this pins down:
 *   - determinism: the same directory tars to the same sha256, twice in a row
 *     and across mtime / permission / creation-order differences;
 *   - dotfiles are PACKED (.gitignore, .env.example, .config/) and only the
 *     three junk names (.git, .DS_Store, .venv) are skipped;
 *   - the executable bit survives (a verifier script arrives runnable) and is
 *     normalized to 0o755 / 0o644 so a umask cannot move the digest;
 *   - every other header field is flattened: mtime 0, uid/gid 0, empty
 *     uname/gname, and the gzip header carries no timestamp;
 *   - symlinks never enter the archive (the server rejects them);
 *   - names longer than a USTAR name field still pack;
 *   - the corpus streams off disk instead of being held whole in memory;
 *   - an empty directory is valid bytes and a missing one rejects.
 *
 * Usage:
 *   npm run test:unit:hosted-tar
 *   npx tsx tests/unit/hosted-tar.test.ts
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";

import { tarGzipDirectory } from "../../src/hosted/tar.ts";

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
    const a = await tarGzipDirectory(root);
    const b = await tarGzipDirectory(root);
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
      sha256(await tarGzipDirectory(forward)),
      sha256(await tarGzipDirectory(reverse)),
      "creation order does not change the bytes",
    );
  } finally {
    rmSync(forward, { recursive: true, force: true });
    rmSync(reverse, { recursive: true, force: true });
  }

  // Touching a file must not move the digest — mtime is pinned to 0.
  const touched = fixture((r) => write(r, "a.txt", "a\n"));
  try {
    const before = sha256(await tarGzipDirectory(touched));
    utimesSync(join(touched, "a.txt"), new Date(1e9), new Date(1e9));
    assertEqual(sha256(await tarGzipDirectory(touched)), before, "a changed mtime does not change the bytes");
  } finally {
    rmSync(touched, { recursive: true, force: true });
  }

  // 0o600 and 0o644 are both "not executable" — one archive, one digest.
  const tight = fixture((r) => write(r, "a.txt", "a\n", 0o600));
  const loose = fixture((r) => write(r, "a.txt", "a\n", 0o644));
  try {
    assertEqual(
      sha256(await tarGzipDirectory(tight)),
      sha256(await tarGzipDirectory(loose)),
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
    const names = (await unpack(await tarGzipDirectory(root))).map((e) => e.name);
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
    const byName = new Map((await unpack(await tarGzipDirectory(root))).map((e) => [e.name, e]));
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
    const gzipped = await tarGzipDirectory(root);
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
    const names = (await unpack(await tarGzipDirectory(root))).map((e) => e.name);
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
    const a = await tarGzipDirectory(root);
    const b = await tarGzipDirectory(root);
    const entries = await unpack(a);
    assertEqual(entries.map((e) => e.name), [long], "a 245-byte path round-trips under its own name");
    assertEqual(entries[0]?.content.toString("utf8"), "deep\n", "its content round-trips");
    assertEqual(sha256(a), sha256(b), "a long path is still deterministic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The corpus streams off disk. A whole-file read would hold the file as one
 * Buffer for the length of the gzip, which `arrayBuffers` would show; the
 * streaming path never holds more than a read buffer at a time.
 */
async function testStreamsFromDisk(): Promise<void> {
  console.log("\n[8] The corpus streams off disk");
  const MB = 1024 * 1024;
  const SIZE = 64 * MB;
  // Zeros: the file is large on disk but the gzip output is tiny, so anything
  // the sampler sees is the INPUT side. Written a chunk at a time, so the test
  // itself never holds the file either.
  const chunk = Buffer.alloc(4 * MB);
  const root = fixture((r) => {
    const fd = openSync(join(r, "big.bin"), "w");
    try {
      for (let written = 0; written < SIZE; written += chunk.length) writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
  });
  try {
    // Collect first, so what the sampler sees is memory still HELD, not
    // read-buffer garbage that has not been swept yet. The suite runs this
    // file with --expose-gc for exactly this measurement.
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
    let gzipped: Buffer;
    try {
      gzipped = await tarGzipDirectory(root);
    } finally {
      clearInterval(sampler);
    }
    assert(peak < 8 * MB, `held bytes stay far under the 64MB file (peak ${(peak / MB).toFixed(1)}MB)`);
    const entries = await unpack(gzipped);
    assertEqual(entries.length, 1, "the large file packs as one entry");
    assertEqual(entries[0]?.content.length, SIZE, "the large file round-trips at full length");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** An empty directory produces a valid, empty archive rather than throwing. */
async function testEmptyDirectory(): Promise<void> {
  console.log("\n[9] An empty directory is a valid empty archive");
  const root = fixture(() => {});
  try {
    const gzipped = await tarGzipDirectory(root);
    assertEqual((await unpack(gzipped)).length, 0, "no entries");
    assertEqual(gunzipSync(gzipped).length, 1024, "two zero blocks = end of archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A directory that is not there rejects; it never resolves to empty bytes. */
async function testMissingDirectoryRejects(): Promise<void> {
  console.log("\n[10] A missing directory rejects");
  const root = fixture(() => {});
  rmSync(root, { recursive: true, force: true });
  try {
    await tarGzipDirectory(root);
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
  console.log("tarGzipDirectory() — the published corpus's bytes\n" + "=".repeat(60));

  await testDeterministicAcrossRuns();
  await testDeterministicAcrossMachineState();
  await testDotfilesArePacked();
  await testExecutableBitSurvives();
  await testHeadersAreFlattened();
  await testSymlinksAreSkipped();
  await testLongPaths();
  await testStreamsFromDisk();
  await testEmptyDirectory();
  await testMissingDirectoryRejects();

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
