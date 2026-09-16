// SOURCE of the rules every provider applies when observing files (mode strings, timestamps,
// ranges); mirrored into the provider packages by `npm run generate:sandbox-errors`.

import { SandboxPathNotFoundError } from "./sandbox-errors";

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

/** The contract's four-digit octal mode from what a provider reports: numeric st_mode, octal string, or an `ls -l` permission string. */
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
