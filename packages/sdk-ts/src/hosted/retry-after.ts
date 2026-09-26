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
  return retryAfterSecFromHeader(res.headers?.get?.("retry-after"));
}

/**
 * The header half of the reading on its own, for a client that keeps the
 * response headers but not the Response (an axios error does).
 */
export function retryAfterSecFromHeader(raw: unknown): number | undefined {
  // An ABSENT header is no reading at all, never zero: `Number(null)` is 0, which told the caller
  // to retry instantly. Empty is absent and the HTTP-date form is unreadable; both leave "retry shortly".
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const fromHeader = Number(raw);
  return Number.isFinite(fromHeader) ? fromHeader : undefined;
}

/** A 429/503 the server wants tried again later, with its delay when the wire carried one. */
export interface TransientRefusal {
  retryAfterSec?: number;
}

/** How many tries a transient refusal gets and how the waits between them are paced. */
export interface TransientRetryPolicy {
  /** Total tries, the first included. */
  attempts: number;
  /** Wait before the second try; doubles after each further refusal. */
  baseDelayMs: number;
  /** Longest single wait, whatever Retry-After asked for. */
  maxDelayMs: number;
}

/**
 * Run `attempt` until it resolves, an error `readRefusal` does not recognize is thrown, or the tries are
 * spent; then the last refusal is thrown as is. Retry-After floored by the backoff (the watch loops' law), capped.
 */
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  readRefusal: (error: unknown) => TransientRefusal | undefined,
  policy: TransientRetryPolicy,
): Promise<T> {
  let backoffMs = policy.baseDelayMs;
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      const refusal = readRefusal(error);
      if (!refusal || tries >= policy.attempts) throw error;
      const askedMs = (refusal.retryAfterSec ?? 0) * 1000;
      const waitMs = Math.min(Math.max(askedMs, backoffMs), policy.maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      backoffMs = Math.min(backoffMs * 2, policy.maxDelayMs);
    }
  }
}
