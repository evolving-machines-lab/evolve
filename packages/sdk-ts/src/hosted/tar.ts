/**
 * Deterministic tar + gzip writer for the directory publish path
 * (datasets().publish({ source: { directory } }) and the agent directory
 * upload), plus the matching reader (`extractTarGz`) that `job download`
 * uses to unpack the server's job archive onto disk.
 *
 * "Deterministic" means the SAME directory content always produces the SAME
 * bytes — the tarball sha256 the server records as the import's source
 * identity has to be reproducible. Three rules buy that: entries are emitted
 * in sorted path order, every header field that could carry machine state is
 * pinned (mtime 0, uid/gid 0, empty uname/gname), and gzip embeds no
 * timestamp.
 *
 * The one header field NOT flattened is the executable bit: a corpus ships
 * verifier and solution scripts, and a script that arrives without +x cannot
 * run. The bit is read from the file and normalized to exactly two values —
 * 0o755 or 0o644 — so a developer's umask still cannot move the digest.
 *
 * What is skipped: symlinks (the server rejects every non-file/dir entry) and
 * three junk names — ".git", ".DS_Store", ".venv". Every OTHER dotfile is
 * PACKED. `.gitignore`, `.dockerignore`, `.env.example` and `.config/` are
 * corpus content, and dropping them published a corpus that did not match the
 * directory on disk.
 *
 * Entries stream from disk through `tar-stream` (already this repo's tar
 * writer, see packages/modal), and the compressed output streams to a FILE
 * (`tarGzipDirectoryToFile`) — neither the corpus nor its archive is ever
 * resident in memory as a whole. The upload side then streams that file onto
 * the wire (see hosted/upload.ts). A 7.7 GB corpus once cost ~10x its size in
 * RSS through the old collect-everything Buffer path and crashed the machine;
 * the only Buffer-returning surface left is `tarGzipDirectory`, kept for the
 * sandbox skill mount, which needs bytes and is size-guarded.
 *
 * The gzip member is written segment by segment (`SegmentedGzipWriter`): an
 * entry whose head SAMPLES as incompressible rides in STORED deflate blocks —
 * a length-prefixed copy, no compression CPU spent — while everything else
 * rides DEFLATE at level 9. Real corpora ship already-compressed blobs
 * (wheels, images, model weights), and gzipping those again once cost ~14 of
 * a 16-minute publish for a 7.7 GB corpus while saving ~2% of its size. The
 * output is still ONE standard gzip member wrapping the SAME tar bytes as
 * before — any gunzip reads it and the server's extraction is untouched; only
 * the compressed byte layout (and so the archive digest) moved, once, with
 * this version. Determinism holds as always: the same directory content
 * produces the same bytes, because every choice in the member — the per-entry
 * stored/deflate decision, the fixed-size block boundaries, the segment
 * switch points (always between entries) — is a function of corpus content
 * alone, never of timing or machine state.
 */
import zlib, { constants as zlibConstants, createGunzip, deflateRawSync } from "node:zlib";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { extract, pack } from "tar-stream";

/**
 * Names never packed, matched at any depth: version-control metadata, a macOS
 * Finder artifact, and the conventional Python virtualenv. All three are
 * machine state rather than corpus, and `.git` alone would blow the server's
 * entry cap. Nothing else is filtered — see the module header.
 */
const SKIP = new Set([".git", ".DS_Store", ".venv"]);

/** One packed file: its archive path, its source path, its normalized mode. */
interface Entry {
  rel: string;
  abs: string;
  mode: number;
  size: number;
}

/** Recursively collect regular files as posix paths relative to `root`, sorted. */
async function listFiles(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (relDir: string): Promise<void> => {
    const absDir = relDir === "" ? root : join(root, relDir);
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(absDir, entry.name);
      const stat = await lstat(abs);
      if (stat.isSymbolicLink()) continue; // never follow or emit symlinks
      if (stat.isDirectory()) await walk(rel);
      // Two modes only: executable-by-anyone becomes 0o755, everything else
      // 0o644, so the developer's umask never reaches the archive.
      else if (stat.isFile()) {
        out.push({ rel, abs, mode: stat.mode & 0o111 ? 0o755 : 0o644, size: stat.size });
      }
    }
  };
  await walk("");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * An entry this size or larger is sampled for compressibility; smaller files
 * always ride DEFLATE — they are metadata and text, and deflating them costs
 * nothing worth a second file open.
 */
const STORED_MIN_SIZE = 64 * 1024;

/** How much of an entry's head the compressibility sample reads. */
const STORED_SAMPLE_BYTES = 128 * 1024;

/**
 * The deflate format's cap on one stored block's payload (16-bit length
 * field), and therefore the block unit of a STORED segment.
 */
const STORED_BLOCK_MAX = 65535;

/**
 * Block unit of a DEFLATE segment: each block is compressed with one
 * synchronous zlib call, primed with the previous 32 KiB of plain tar bytes
 * (`DEFLATE_WINDOW_BYTES`) as its dictionary so matches still reach across
 * block boundaries. Fixed-size blocks make the compressed layout a function
 * of content alone — never of how the tar stream happened to be chunked.
 */
const DEFLATE_BLOCK_BYTES = 1024 * 1024;

/** The deflate window: how much trailing plaintext primes the next block. */
const DEFLATE_WINDOW_BYTES = 32 * 1024;

/**
 * Does this entry ride STORED? True when deflate cannot meaningfully shrink
 * a sample of the file's head: level-1 deflate of the first 128 KiB keeps
 * ≥ 95% of its size. Already-compressed data sits at ~100% under every
 * level; text sits under ~60% even at level 1 — the classes are far apart,
 * so the threshold is not delicate. The cost of a misread is bounded and
 * one-sided per direction: a stored-but-compressible tail costs archive
 * size, a deflated-but-incompressible file costs only the CPU this feature
 * exists to save. The decision reads content, so it is deterministic.
 * Exported only for the unit suite's premise pin — the switch tests assert
 * their fixtures actually land on both sides of this decision.
 */
export async function shouldStore(absPath: string, size: number): Promise<boolean> {
  if (size < STORED_MIN_SIZE) return false;
  const handle = await open(absPath, "r");
  let sample: Buffer;
  try {
    const buf = Buffer.allocUnsafe(STORED_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, STORED_SAMPLE_BYTES, 0);
    sample = buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (sample.length === 0) return false;
  const deflated = deflateRawSync(sample, { level: 1 }).length;
  return deflated * 20 >= sample.length * 19; // kept ≥ 95% — cannot compress
}

/**
 * CRC-32 for the gzip trailer — the standard reflected polynomial 0xEDB88320,
 * value-compatible with `zlib.crc32` including the running-checksum second
 * argument (the unit suite pins the two equal). Exists because native
 * `zlib.crc32` only arrived in Node 20.15 / 22.2 while the SDK's documented
 * floor is Node 18 (README "Node.js 18+"): a NAMED import of `crc32` from
 * node:zlib is a load-time SyntaxError on every older runtime, which took
 * dataset publish, job upload and the sandbox skill mount down with it. So
 * this module default-imports zlib and resolves the native function below —
 * never turn that back into a named import. Exported only for the equality
 * pin in the unit suite.
 */
export function crc32Fallback(data: Uint8Array, value = 0): number {
  let crc = ~value;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** Native where the runtime has it (Node >= 20.15 / 22.2), fallback above. */
const crc32: (data: Uint8Array, value?: number) => number = zlib.crc32 ?? crc32Fallback;

/**
 * Writes ONE standard gzip member as a sequence of segments: DEFLATE
 * segments (level 9) for compressible bytes, STORED segments (raw copy in
 * length-prefixed deflate blocks, no compression CPU) for bytes that cannot
 * compress. `setStored` switches segments — only ever called between tar
 * entries, so a switch point is a function of corpus content.
 *
 * The member is assembled by hand — fixed 10-byte header, raw deflate body,
 * crc32 + length trailer — because zlib's own gzip stream cannot change
 * level mid-member cheaply (Node's `params(0)` still routes every stored
 * byte through the async transform, which measured slower than deflating).
 * Every block is emitted with a synchronous zlib call or none at all, and
 * both segment kinds end byte-aligned (deflate blocks via Z_SYNC_FLUSH), so
 * blocks concatenate into one valid deflate stream that any inflater reads.
 * A deflate block is primed with the previous 32 KiB of plain bytes as its
 * dictionary — matches an inflater resolves against its own output window,
 * stored bytes included.
 *
 * Bytes are collected into fixed-size blocks (65535 stored / 1 MiB deflate,
 * greedily per segment) before emission, so the compressed layout never
 * depends on how the incoming stream was chunked. Held memory is O(block).
 */
class SegmentedGzipWriter {
  /** CM=8 (deflate), no flags, MTIME 0, XFL 0, OS 255 (unknown). */
  private static readonly HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
  /** BFINAL stored block with an empty payload: terminates the member. */
  private static readonly FINAL_BLOCK = Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]);

  private crc = 0;
  private plainLength = 0;
  private held: Buffer[] = [];
  private heldBytes = 0;
  private window: Buffer | null = null;
  private stored = false;
  private started = false;

  constructor(private readonly sink: WriteStream) {}

  /** Switch segment kind. Only valid between tar entries. */
  async setStored(stored: boolean): Promise<void> {
    if (stored === this.stored) return;
    await this.drainHeld(true); // finish the current segment's remainder block
    this.stored = stored;
  }

  async write(chunk: Buffer): Promise<void> {
    if (!this.started) {
      this.started = true;
      await this.out(SegmentedGzipWriter.HEADER);
    }
    this.held.push(chunk);
    this.heldBytes += chunk.length;
    await this.drainHeld(false);
  }

  /** Flush the remainder, terminate the deflate stream, write the trailer. */
  async close(): Promise<void> {
    if (!this.started) {
      this.started = true;
      await this.out(SegmentedGzipWriter.HEADER);
    }
    await this.drainHeld(true);
    await this.out(SegmentedGzipWriter.FINAL_BLOCK);
    const trailer = Buffer.allocUnsafe(8);
    trailer.writeUInt32LE(this.crc >>> 0, 0);
    trailer.writeUInt32LE(this.plainLength % 0x100000000, 4); // ISIZE is mod 2^32
    await this.out(trailer);
  }

  /** Emit full blocks; with `flushAll`, also the sub-block remainder. */
  private async drainHeld(flushAll: boolean): Promise<void> {
    const unit = this.stored ? STORED_BLOCK_MAX : DEFLATE_BLOCK_BYTES;
    while (this.heldBytes >= unit || (flushAll && this.heldBytes > 0)) {
      const all = this.held.length === 1 ? this.held[0]! : Buffer.concat(this.held, this.heldBytes);
      const take = Math.min(unit, all.length);
      const rest = all.subarray(take);
      this.held = rest.length > 0 ? [rest] : [];
      this.heldBytes = rest.length;
      await this.emitBlock(all.subarray(0, take));
    }
  }

  private async emitBlock(block: Buffer): Promise<void> {
    this.crc = crc32(block, this.crc);
    this.plainLength += block.length;
    if (this.stored) {
      // 00 (BFINAL=0, BTYPE=stored) + LEN + ~LEN, then the bytes verbatim.
      const framed = Buffer.allocUnsafe(5 + block.length);
      framed[0] = 0x00;
      framed.writeUInt16LE(block.length, 1);
      framed.writeUInt16LE(block.length ^ 0xffff, 3);
      block.copy(framed, 5);
      await this.out(framed);
    } else {
      await this.out(
        deflateRawSync(block, {
          level: 9,
          finishFlush: zlibConstants.Z_SYNC_FLUSH, // byte-aligned, BFINAL never set
          ...(this.window ? { dictionary: this.window } : {}),
        })
      );
    }
    // Roll the dictionary window: the last 32 KiB of plain bytes emitted.
    this.window =
      block.length >= DEFLATE_WINDOW_BYTES
        ? Buffer.from(block.subarray(block.length - DEFLATE_WINDOW_BYTES))
        : this.window
          ? Buffer.concat([this.window, block]).subarray(-DEFLATE_WINDOW_BYTES)
          : Buffer.from(block);
  }

  /** One serialized write to the file; the callback carries any fs error. */
  private out(chunk: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sink.write(chunk, (err) => (err == null ? resolve() : reject(err)));
    });
  }
}

/** The pump's marker for "the entry's feed settled" in its race with data. */
const FEED_SETTLED = Symbol("feed settled");

/**
 * `winner` if the promise is already settled, `null` if it is still pending —
 * without ever waiting on it. Race order makes the tie deterministic: a
 * settled `p` queued its reaction first, so it beats the fresh marker.
 */
async function settledValue<T>(p: Promise<T>): Promise<T | null> {
  const PENDING = Symbol("pending");
  const winner = await Promise.race([p, Promise.resolve(PENDING)]);
  return winner === PENDING ? null : (winner as T);
}

/**
 * Deterministically tar + gzip a corpus directory into `outPath`, ready for
 * the streaming multipart upload (hosted/upload.ts) to put on the wire.
 *
 * Everything flows in O(block) memory: files feed the tar pack one read
 * buffer at a time, the pump drains the pack into the segmented gzip writer,
 * and the compressed stream lands on disk instead of in a Buffer. The tar
 * BYTES are the same as ever (same entry walk, same headers); the gzip body
 * around them is segmented per entry — see the module header.
 *
 * The pump is the pack's ONLY consumer, and it pulls through the pack's
 * async iterator rather than `read()`/`'readable'`: the iterator subscribes
 * one persistent listener at creation, so a chunk pushed while the pump is
 * between waits cannot fire `'readable'` into the void and deadlock it
 * (streamx latches that event until a read empties the buffer). An in-flight
 * `next()` is parked across entry boundaries, never abandoned — a parked
 * chunk is the NEXT entry's first bytes, written only after the segment
 * switch, which is what keeps a switch exactly on the boundary: tar-stream
 * pushes an entry's header, body and padding synchronously as the entry is
 * written, so when its feed has settled and the iterator runs dry, every
 * byte of that entry has passed through the writer.
 */
export async function tarGzipDirectoryToFile(root: string, outPath: string): Promise<void> {
  const files = await listFiles(root);
  const tar = pack();
  const sink = createWriteStream(outPath);
  // Failures surface through write callbacks and finished(); without a
  // listener the duplicate 'error' event would crash the process.
  sink.on("error", () => {});
  tar.on("error", () => {});
  const gz = new SegmentedGzipWriter(sink);

  const chunks = tar[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let parked: Promise<IteratorResult<Buffer>> | null = null;
  const nextChunk = (): Promise<IteratorResult<Buffer>> => (parked ??= chunks.next());

  try {
    for (const { rel, abs, mode, size } of files) {
      await gz.setStored(await shouldStore(abs, size));
      const entry = tar.entry({
        name: rel,
        size,
        mode,
        mtime: new Date(0),
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
        type: "file",
      });
      const feed = pipeline(createReadStream(abs), entry);
      // Pump while feeding — the pack's buffer is bounded, so an undrained
      // pack would deadlock the feed. The feed's rejection, if any, is
      // propagated by the `await feed` below. The feed side gets ONE
      // reaction, waking whichever wait is current through a mutable slot —
      // a per-chunk Promise.race would pin every won chunk in the pending
      // side's reaction list until the feed settles (each reaction holds its
      // settled race promise, and that holds the chunk), which once held a
      // whole corpus file live.
      let feedDone = false;
      let wakePump: ((v: typeof FEED_SETTLED) => void) | null = null;
      void feed
        .then(
          () => {},
          () => {}
        )
        .then(() => {
          feedDone = true;
          wakePump?.(FEED_SETTLED);
        });
      for (;;) {
        if (!feedDone) {
          const won = await new Promise<IteratorResult<Buffer> | typeof FEED_SETTLED>((resolve, reject) => {
            wakePump = resolve;
            nextChunk().then(resolve, reject);
          });
          wakePump = null;
          if (won === FEED_SETTLED) continue; // go again down the settled path
          parked = null;
          if (won.done) break;
          await gz.write(won.value);
          continue;
        }
        // The feed settled: its bytes are all pushed. Drain what the
        // iterator already holds; one macrotask turn lets streamx's queued
        // (microtask) delivery reach a pending next() first. A next() still
        // pending after that is the boundary — nothing more can arrive.
        await new Promise((resolve) => setImmediate(resolve));
        const held = await settledValue(nextChunk());
        if (held === null) break;
        parked = null;
        if (held.done) break;
        await gz.write(held.value);
      }
      await feed;
    }
    tar.finalize();
    for (;;) {
      const result = await nextChunk();
      parked = null;
      if (result.done) break;
      await gz.write(result.value);
    }
    await gz.close();
    sink.end();
    await finished(sink);
  } catch (error) {
    // `parked` is assigned inside nextChunk(), invisible to narrowing here.
    (parked as Promise<IteratorResult<Buffer>> | null)?.catch(() => {});
    tar.destroy();
    sink.destroy();
    throw error;
  }
}

/**
 * The one Buffer-returning packer left, for the single caller that NEEDS the
 * archive as bytes: the sandbox skill mount (skills.ts), whose provider
 * `files.write()` seam takes a value, not a path. Every hosted upload streams
 * from disk via `tarGzipDirectoryToFile` instead — never add an upload caller
 * here.
 *
 * Size-guarded so this path can never recreate the incident that killed the
 * in-memory uploads (a multi-GB archive held whole): past `maxBytes`
 * (default 256 MiB — generous for a skill folder, far below harm) it refuses
 * with the measured size rather than degrade into an OOM. `maxBytes` is a
 * parameter only so tests can prove the guard without a 256 MiB fixture.
 */
export const MAX_INLINE_ARCHIVE_BYTES = 256 * 1024 * 1024;

export async function tarGzipDirectory(
  root: string,
  maxBytes: number = MAX_INLINE_ARCHIVE_BYTES
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "evolve-tar-"));
  try {
    const archive = join(dir, "archive.tar.gz");
    await tarGzipDirectoryToFile(root, archive);
    const { size } = await stat(archive);
    if (size > maxBytes) {
      throw new Error(
        `directory ${root} tars to ${size} bytes compressed — over the ` +
          `${maxBytes}-byte cap for in-memory archives. Only the sandbox ` +
          `skill mount uses this path; a skill folder this large is not mountable.`
      );
    }
    return await readFile(archive);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Unpack a downloaded .tar.gz onto disk — the read half of this module, used
 * by `job download` to turn the server's job archive into the real directory
 * tree the docs promise (`<dest>/job-<id>/...`).
 *
 * The archive comes from our own server, but the extractor still refuses to
 * be a confused deputy: every entry must live under `root/` (the top-level
 * directory the caller expects), no entry may be an absolute path or climb
 * out with `..`, and only plain files and directories are written — a
 * symlink, hardlink or device node in the stream is an error, never a
 * silently created foothold. Paths are split on `/` and rejoined with the
 * platform separator, so an archive written with posix names lands correctly
 * everywhere.
 *
 * Entries stream straight from the gunzip to their files — the archive is
 * never resident in memory as a whole. Returns the archive-relative paths of
 * the files written, in archive order.
 */
export async function extractTarGz(archivePath: string, destDir: string, root: string): Promise<string[]> {
  const ex = extract();
  const written: string[] = [];

  const consume = (async () => {
    for await (const entry of ex) {
      const name = entry.header.name;
      const segments = name
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".");
      // Backslash refused outright: tar names are posix, and a backslash that
      // is an ordinary character here becomes a path separator on Windows.
      if (name.startsWith("/") || name.includes("\\") || segments.length === 0 || segments.some((s) => s === "..")) {
        throw new Error(`refusing to extract "${name}": the path escapes the target directory`);
      }
      if (segments[0] !== root) {
        throw new Error(`refusing to extract "${name}": entry outside ${root}/`);
      }
      if (entry.header.type === "directory") {
        await mkdir(join(destDir, ...segments), { recursive: true });
        entry.resume();
        continue;
      }
      if (entry.header.type !== "file") {
        throw new Error(`refusing to extract "${name}": unsupported entry type "${entry.header.type}"`);
      }
      const target = join(destDir, ...segments);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(entry, createWriteStream(target));
      written.push(segments.join("/"));
    }
  })();

  try {
    await Promise.all([pipeline(createReadStream(archivePath), createGunzip(), ex), consume]);
  } catch (error) {
    // A refused entry aborts the whole extraction; destroying the parser
    // settles the other pipeline instead of leaving it wedged mid-stream.
    ex.destroy();
    throw error;
  }
  return written;
}
