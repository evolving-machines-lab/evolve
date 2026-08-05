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
 * writer, see packages/modal), so the corpus is never resident in memory as a
 * whole — only the compressed output is collected, since the upload takes one
 * body.
 */
import { createGunzip, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
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
 * Deterministically tar + gzip a corpus directory into a single gzipped-tar
 * buffer, ready to upload to POST /api/datasets/publish.
 */
export async function tarGzipDirectory(root: string): Promise<Buffer> {
  const files = await listFiles(root);
  const tar = pack();
  const gzip = createGzip({ level: 9 });

  const chunks: Buffer[] = [];
  const collect = (async () => {
    for await (const chunk of gzip) chunks.push(Buffer.from(chunk));
  })();

  // Feed the pack while gzip drains it: a file crosses one read buffer at a
  // time and is never held whole.
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

  await Promise.all([pipeline(tar, gzip), feed, collect]);
  return Buffer.concat(chunks);
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
