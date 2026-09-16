/**
 * The rules every provider applies when it observes a sandbox's files — ONE
 * home, three declared mirrors (same arrangement as ./sandbox-errors.ts: the
 * provider packages cannot import the SDK, so `npm run generate:sandbox-errors`
 * copies this file into each of them and packages/sdk-ts/tests/unit/
 * sandbox-errors.test.ts fails the suite when a copy is stale). Edit the
 * source, never a mirror.
 *
 * What lives here is deliberately small: the checks and conversions that the
 * contract (types.ts FileInfo / FileRange) fixes for every provider, so that
 * "0644" means the same bits and a range read answers the same way whichever
 * box served it. Provider-specific transport stays in each adapter.
 */

import { SandboxPathNotFoundError } from "./sandbox-errors";

/** A byte range as the contract states it (types.ts FileRange). */
export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * Exit codes the read-only in-box scripts (Daytona's find listing, Modal's
 * range read) use to say WHY they stopped before producing anything. They are
 * the errno values of the same conditions (`errno(3)`: ENOENT 2, ENOTDIR 20,
 * EISDIR 21), so a reader of the script or of a raw exit code recognises
 * them without a table of our own.
 */
export const EXIT_ENOENT = 2;
export const EXIT_ENOTDIR = 20;
export const EXIT_EISDIR = 21;

/** Single-quote a path for a POSIX shell: the only quoting that needs no escaping but the quote itself. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Refuse a range that cannot name bytes — before any request is made, so a
 * caller's bug never costs a round trip or reads the wrong bytes.
 */
export function assertByteRange(range: ByteRange): void {
  if (!Number.isInteger(range.offset) || range.offset < 0) {
    throw new RangeError(`offset must be a non-negative integer, got ${range.offset}`);
  }
  if (!Number.isInteger(range.length) || range.length < 0) {
    throw new RangeError(`length must be a non-negative integer, got ${range.length}`);
  }
}

/**
 * The contract's mode string: the permission bits (setuid, setgid, sticky,
 * rwx ×3) as four octal digits — "0644", "4755". Accepts what the three
 * providers report: a numeric st_mode (Modal's 33188, E2B's 420 — type bits
 * are masked off), a bare or padded octal string (Daytona's "644" / "0644"),
 * or an `ls -l`-style permission string ("-rw-r--r--", "Lrwxrwxrwx",
 * "rwsr-xr-x" — a leading type character is skipped, s/S/t/T carry the
 * special bits).
 */
export function octalMode(input: number | string): string {
  if (typeof input === "number") return pad4((input & 0o7777).toString(8));
  if (/^[0-7]{3,4}$/.test(input)) return pad4(input);
  return pad4(bitsOfPermissionString(input).toString(8));
}

function pad4(octal: string): string {
  return octal.padStart(4, "0");
}

function bitsOfPermissionString(perms: string): number {
  const p = perms.length === 10 ? perms.slice(1) : perms;
  if (p.length !== 9) throw new RangeError(`not a permission string: ${perms}`);
  let bits = 0;
  const triplets: Array<[number, number]> = [
    [0, 0o4000], // owner: setuid
    [3, 0o2000], // group: setgid
    [6, 0o1000], // other: sticky
  ];
  for (const [at, special] of triplets) {
    const r = p[at] === "r";
    const w = p[at + 1] === "w";
    const x = p[at + 2];
    const shift = 6 - at;
    if (r) bits |= 0o4 << shift;
    if (w) bits |= 0o2 << shift;
    if (x === "x" || x === "s" || x === "t") bits |= 0o1 << shift;
    if (x === "s" || x === "S" || x === "t" || x === "T") bits |= special;
  }
  return bits;
}

/**
 * ISO 8601 from whatever the provider hands over: a Date (E2B), epoch seconds
 * with an optional fraction (Modal's integer seconds, find's `%T@`), or an
 * already-formatted timestamp (Daytona's RFC 3339). Millisecond precision on
 * every provider, so timestamps compare across boxes.
 */
export function isoTime(input: Date | number | string): string {
  const date =
    input instanceof Date ? input : typeof input === "number" ? new Date(input * 1000) : new Date(input);
  if (Number.isNaN(date.getTime())) throw new RangeError(`not a timestamp: ${String(input)}`);
  return date.toISOString();
}

/** The parent-relative join every list() uses: `dir/name`, never `dir//name`. */
export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * Exactly the bytes of `range` from a file served over HTTP, asked for with a
 * `Range` header (the byte-exact, small-transfer path both E2B's envd and
 * Daytona's daemon honour: 206, measured on 200 MB files on 2026-09-16).
 *
 * Every status has one meaning:
 *   206 — the range, possibly shortened at the end of the file;
 *   200 — the server ignored Range and is sending the whole file: the slice
 *         is cut out of the stream and the rest cancelled, so the answer is
 *         still exact, only slower (the caller pays `offset + length` bytes);
 *   416 — the range starts past the end: an empty read, like read(2) at EOF;
 *   404 — SandboxPathNotFoundError;
 *   anything else — an Error naming the status.
 */
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
