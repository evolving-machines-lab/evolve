/**
 * The ONE Retry-After reading, body first because a cross-origin browser fetch cannot always see the
 * header: the typed error, the SSE follow, the resumable upload and the managed doors all read the delay here.
 */
export function readRetryAfterSec(text: string, res: Response): number | undefined {
  try {
    const body = JSON.parse(text) as { error?: { retryAfterSec?: unknown } };
    const fromBody = body?.error?.retryAfterSec;
    // Finite or absent: `JSON.parse('1e400')` is Infinity, and a caller sleeping Infinity is parked forever.
    if (typeof fromBody === "number" && Number.isFinite(fromBody)) return fromBody;
  } catch {
    // Unparseable body: the header is the only reading left.
  }
  return retryAfterSecFromHeader(res.headers?.get?.("retry-after"));
}

/** The header half on its own, for a client that keeps the response headers but not the Response. */
export function retryAfterSecFromHeader(raw: unknown): number | undefined {
  // Absent, empty or an HTTP-date is no reading, never zero: `Number(null)` is 0, which meant "retry now".
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const fromHeader = Number(raw);
  return Number.isFinite(fromHeader) ? fromHeader : undefined;
}

/** A 429/503 the server wants tried again later, with its delay when the wire carried one. */
export interface TransientRefusal {
  retryAfterSec?: number;
}

/** `attempts` tries in all; the wait starts at `baseDelayMs`, doubles per refusal, never exceeds `maxDelayMs`. */
export interface TransientRetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Tries `attempt` until it resolves or the tries are spent; an unrecognized error is thrown at once, the last refusal as is. */
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
