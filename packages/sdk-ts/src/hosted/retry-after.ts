/**
 * The ONE Retry-After reading: the envelope's `retryAfterSec` first and the
 * `Retry-After` header second, because a cross-origin browser fetch cannot
 * always see the header. Every retry path reads the delay through here — the
 * typed error, the SSE follow's own backoff, and the resumable upload's
 * rate-limit waits — so the same 429 delays the same amount whichever half
 * of the wire carries the number.
 */
export function readRetryAfterSec(text: string, res: Response): number | undefined {
  try {
    const body = JSON.parse(text) as { error?: { retryAfterSec?: unknown } };
    const fromBody = body?.error?.retryAfterSec;
    // Finite or absent, in the BODY too: `JSON.parse('1e400')` is Infinity, and
    // a caller sleeping Infinity is parked forever with no bound and no output.
    // A delay that cannot be waited is no reading at all.
    if (typeof fromBody === "number" && Number.isFinite(fromBody)) return fromBody;
  } catch {
    // Unparseable body: the header is the only reading left.
  }
  // An ABSENT header is no reading at all, never zero: `Number(null)` is 0 and
  // 0 is finite, so a bare Number() told the caller to retry instantly — the
  // one thing a rate limit forbids. Empty is absent, and the HTTP-date form
  // (which we do not parse) is unreadable — both leave "retry shortly".
  const rawHeader = res.headers?.get?.("retry-after");
  if (typeof rawHeader !== "string" || rawHeader.trim() === "") return undefined;
  const fromHeader = Number(rawHeader);
  return Number.isFinite(fromHeader) ? fromHeader : undefined;
}
