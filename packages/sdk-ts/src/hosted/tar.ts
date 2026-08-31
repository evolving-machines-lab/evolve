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
 */
import { createGunzip, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
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
 * Deterministically tar + gzip a corpus directory into `outPath`, ready for
 * the streaming multipart upload (hosted/upload.ts) to put on the wire.
 *
 * Everything flows in O(read-buffer) memory: files feed the tar pack one read
 * buffer at a time, gzip drains the pack, and the compressed stream lands on
 * disk instead of in a Buffer. The BYTES are identical to what the old
 * in-memory path produced (same entry walk, same headers, same gzip level 9,
 * same zlib stream) — the server-side sha256 of a corpus does not move.
 */
export async function tarGzipDirectoryToFile(root: string, outPath: string): Promise<void> {
  const files = await listFiles(root);
  const tar = pack();
  const gzip = createGzip({ level: 9 });

  // Feed the pack while gzip drains it into the file: a source file crosses
  // one read buffer at a time and is never held whole.
  const feed = (async () => {
    for (const { rel, abs, mode, size } of files) {
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
      await pipeline(createReadStream(abs), entry);
    }
    tar.finalize();
  })();

  await Promise.all([pipeline(tar, gzip, createWriteStream(outPath)), feed]);
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
