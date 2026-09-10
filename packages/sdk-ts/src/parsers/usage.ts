/**
 * Shared readers for the per-line facts every parser stamps on its events
 * (parsers/types.ts OutputEvent: timestamp, usage). One home per arithmetic,
 * so two harnesses that print the same wire shape can never disagree on what
 * a counter means.
 */

import type { TokenUsage } from "./types";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Anthropic-shaped usage — `input_tokens`, `output_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens` — as claude's
 * `message.usage` and `result.usage` print it, and as droid's `completion.usage`
 * repeats it under the same names.
 *
 * Harbor's arithmetic, claude_code.py:842-853: prompt_tokens is input PLUS
 * the cache-read and cache-creation shares ("align with Anthropic session
 * totals"), completion is output, cached is the cache-read share, and every
 * other key rides `extra` verbatim. A key the line did not carry is absent;
 * a key present but null (an interrupted stream) counts as 0 for the sum
 * exactly as Harbor's `or 0` does, and is then omitted from `extra`.
 *
 * Returns null when `usage` is not an object — the line reported nothing.
 */
export function anthropicTokenUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const input = finiteNumber(record.input_tokens);
  const output = finiteNumber(record.output_tokens);
  const cacheRead = finiteNumber(record.cache_read_input_tokens);
  const cacheCreation = finiteNumber(record.cache_creation_input_tokens);

  const result: TokenUsage = {};
  if (input !== undefined || cacheRead !== undefined || cacheCreation !== undefined) {
    result.promptTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
  }
  if (output !== undefined) result.completionTokens = output;
  if (cacheRead !== undefined) result.cachedTokens = cacheRead;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "input_tokens" || key === "output_tokens") continue;
    if (value === null || value === undefined) continue;
    extra[key] = value;
  }
  if (Object.keys(extra).length > 0) result.extra = extra;
  return result;
}

/**
 * A wire timestamp as ISO 8601: an ISO string passes through untouched, an
 * epoch in milliseconds (opencode, droid) is converted. Anything else — no
 * field, a non-finite number — is absent, never "now".
 */
export function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}
