/**
 * Deterministic USTAR + gzip writer for the directory import path
 * (benchmarks().import({ source: { directory } })).
 *
 * "Deterministic" means the SAME directory content always produces the SAME
 * bytes — so the tarball sha256 the server records as the import's source
 * identity is reproducible: entries are sorted by path, headers are normalized
 * (mtime 0, uid/gid 0, empty uname/gname, fixed mode), and gzip carries no
 * timestamp. Hidden entries (".git", ".DS_Store", ".venv") and symlinks are
 * skipped — a corpus is plain files, and the server rejects symlinks anyway.
 *
 * Dependency-free on purpose (the published SDK stays lean): a minimal USTAR
 * writer, which node-tar on the server extracts under its own path hardening.
 */
import { gzipSync } from "node:zlib";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BLOCK = 512;

/** Recursively collect regular files as posix paths relative to `root`, sorted. */
function listFiles(root: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (relDir: string): void => {
    const absDir = relDir === "" ? root : join(root, relDir);
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip hidden (.git/.DS_Store/.venv)
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(absDir, entry.name);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) continue; // never follow or emit symlinks
      if (stat.isDirectory()) walk(rel);
      else if (stat.isFile()) out.push({ rel, abs });
    }
  };
  walk("");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** One 512-byte USTAR file header (regular file, normalized for determinism). */
function fileHeader(path: string, size: number): Buffer {
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    // USTAR long names split at a "/": prefix <= 155 bytes, name <= 100 bytes.
    // Prefer the LATEST valid split so the most path stays in `name`.
    let split = -1;
    for (let i = name.indexOf("/"); i !== -1; i = name.indexOf("/", i + 1)) {
      const p = name.slice(0, i);
      const n = name.slice(i + 1);
      if (n.length > 0 && Buffer.byteLength(n, "utf8") <= 100 && Buffer.byteLength(p, "utf8") <= 155) {
        split = i;
      }
    }
    if (split === -1) {
      throw new Error(`path too long to store in a USTAR tar (max 255 bytes, split at "/"): ${path}`);
    }
    prefix = name.slice(0, split);
    name = name.slice(split + 1);
  }

  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, "utf8"); // name (100)
  b.write("0000644\0", 100, "ascii"); // mode (8) — 0644
  b.write("0000000\0", 108, "ascii"); // uid (8) — 0
  b.write("0000000\0", 116, "ascii"); // gid (8) — 0
  b.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii"); // size (12)
  b.write("00000000000\0", 136, "ascii"); // mtime (12) — 0
  b.write("        ", 148, "ascii"); // chksum (8) — spaces while summing
  b.write("0", 156, "ascii"); // typeflag (1) — regular file
  b.write("ustar\0", 257, "ascii"); // magic (6)
  b.write("00", 263, "ascii"); // version (2)
  // uname/gname/devmajor/devminor stay zero (deterministic).
  if (prefix) b.write(prefix, 345, 155, "utf8"); // prefix (155)

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += b[i];
  // Checksum: 6 octal digits, a NUL, then a space (the canonical USTAR form).
  b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return b;
}

/**
 * Deterministically tar + gzip a corpus directory into a single gzipped-tar
 * buffer, ready to upload to POST /api/benchmarks/imports.
 */
export function tarGzipDirectory(root: string): Buffer {
  const files = listFiles(root);
  const parts: Buffer[] = [];
  for (const { rel, abs } of files) {
    const content = readFileSync(abs);
    parts.push(fileHeader(rel, content.length));
    parts.push(content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // two zero blocks = end of archive
  // mtime is not part of a raw tar; gzipSync embeds no timestamp, so the whole
  // .tar.gz is a pure function of the directory content.
  return gzipSync(Buffer.concat(parts), { level: 9 });
}
