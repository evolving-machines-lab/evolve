// SOURCE of the rules every provider applies when observing files (mode strings, timestamps,
// ranges); mirrored into the provider packages by `npm run generate:sandbox-errors`.

import { constants as fs } from "node:fs";
import { SandboxPathNotFoundError } from "./sandbox-errors";

/** The contract's entry types (types.ts FileInfo). */
export type EntryType = "file" | "dir" | "symlink" | "other";

/** A byte range as the contract states it (types.ts FileRange). */
export interface ByteRange {
  offset: number;
  length: number;
}

// Exit codes of the in-box read-only scripts: the errno values of the same conditions (errno(3)).
export const EXIT_ENOENT = 2;
export const EXIT_ENOTDIR = 20;
export const EXIT_EISDIR = 21;

/** Single-quote a path for a POSIX shell. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Refused before any request, so a caller's bug never reads the wrong bytes. */
export function assertByteRange(range: ByteRange): void {
  if (!Number.isInteger(range.offset) || range.offset < 0) {
    throw new RangeError(`offset must be a non-negative integer, got ${range.offset}`);
  }
  if (!Number.isInteger(range.length) || range.length < 0) {
    throw new RangeError(`length must be a non-negative integer, got ${range.length}`);
  }
}

/** The contract's four-digit octal mode from a numeric st_mode or an octal string; anything else is refused. */
export function octalMode(input: number | string): string {
  if (typeof input === "number") return pad4((input & 0o7777).toString(8));
  // One to four digits: GNU find's %m prints the mode unpadded ("0" for chmod 000, "10" for 010; measured 2026-09-16).
  if (/^[0-7]{1,4}$/.test(input)) return pad4(input);
  throw new RangeError(`not an octal mode: ${input}`);
}

function pad4(octal: string): string {
  return octal.padStart(4, "0");
}

/** The entry type a POSIX st_mode carries in its S_IFMT bits (sys/stat.h; the masks are Node's own fs.constants). */
export function entryTypeOfMode(mode: number): EntryType {
  const format = mode & fs.S_IFMT;
  return format === fs.S_IFDIR ? "dir" : format === fs.S_IFLNK ? "symlink" : format === fs.S_IFREG ? "file" : "other";
}

/** What a Go `os.FileMode.String()` names: the entry's own type and the contract's four-digit octal mode. */
export interface GoFileMode {
  type: EntryType;
  mode: string;
}

// Go prints one letter per set bit from "dalTLDpSugct?" (or "-" when none), then nine rwx characters
// (go/src/io/fs/fs.go:238-259); E2B's envd is Go and reports this string. No npm package parses it.
const GO_FILE_MODE = /^(-|[dalTLDpSugct?]+)([-r][-w][-x]){3}$/;

export function parseGoFileMode(text: string): GoFileMode {
  if (!GO_FILE_MODE.test(text)) throw new RangeError(`not a Go file mode string: ${text}`);
  const prefix = text.slice(0, -9);
  const rwx = text.slice(-9);
  const type: EntryType = prefix.includes("d")
    ? "dir"
    : prefix.includes("L")
      ? "symlink"
      : /[DpSc?]/.test(prefix)
        ? "other"
        : "file";
  let bits = (prefix.includes("u") ? 0o4000 : 0) | (prefix.includes("g") ? 0o2000 : 0) | (prefix.includes("t") ? 0o1000 : 0);
  for (let i = 0; i < 9; i++) if (rwx[i] !== "-") bits |= 1 << (8 - i);
  return { type, mode: pad4(bits.toString(8)) };
}

/** ISO 8601 at millisecond precision from a Date, epoch seconds, or an RFC 3339 string, so timestamps compare across providers. */
export function isoTime(input: Date | number | string): string {
  const date =
    input instanceof Date ? input : typeof input === "number" ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a timestamp: ${String(input)}`);
  return date.toISOString();
}

/** `dir/name`, never `dir//name`. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** A `Range` request on a file URL (E2B's envd and Daytona's daemon both answer 206, measured 2026-09-16).
 *  206 → the bytes; 200 → the slice cut from the stream; 416 → empty (past EOF); 404 → not found. */
export async function readByteRangeOverUrl(
  url: string,
  range: ByteRange,
  context: { provider: string; path: string; timeoutMs: number },
): Promise<Uint8Array> {
  assertByteRange(range);
  if (range.length === 0) return new Uint8Array(0);
  const end = range.offset + range.length - 1;
  const response = await fetch(url, {
    headers: { Range: `bytes=${range.offset}-${end}` },
    signal: AbortSignal.timeout(context.timeoutMs),
  });
  if (response.status === 206) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > range.length ? bytes.subarray(0, range.length) : bytes;
  }
  if (response.status === 200) return sliceStream(response, range);
  if (response.status === 416) {
    await response.body?.cancel().catch(() => {});
    return new Uint8Array(0);
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 404) throw new SandboxPathNotFoundError(context.path, context.provider);
  throw new Error(`${context.provider}: range read of ${context.path} failed (HTTP ${response.status})`);
}

async function sliceStream(response: Response, range: ByteRange): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  let collected = 0;
  const stop = range.offset + range.length;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const start = seen;
      seen += value.length;
      if (seen > range.offset) {
        const from = Math.max(0, range.offset - start);
        const to = Math.min(value.length, stop - start);
        if (to > from) {
          parts.push(value.subarray(from, to));
          collected += to - from;
        }
      }
      if (seen >= stop) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(collected);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
