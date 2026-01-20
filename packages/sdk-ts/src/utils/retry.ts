/**
 * Retry Utility
 *
 * Generic retry with exponential backoff for Swarm operations.
 * Works with any result type that has a status field.
 * Retries on error status by default, with customizable retry conditions.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

// =============================================================================
// TYPES
// =============================================================================

/** Any result with a status field (SwarmResult, ReduceResult, etc.) */
export interface RetryableResult {
  status: "success" | "error" | "filtered";
  error?: string;
}

/**
 * Per-item retry configuration.
 *
 * @example
 * ```typescript
 * // Basic retry on error
 * { maxAttempts: 3 }
 *
 * // With exponential backoff
 * { maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2 }
 *
 * // Custom retry condition (when using typed RetryConfig<SwarmResult<T>>)
 * { maxAttempts: 3, retryOn: (r) => r.status === "error" || r.error?.includes("timeout") }
 *
 * // With retry callback for observability
 * { maxAttempts: 3, onItemRetry: (idx, attempt, error) => console.log(`Item ${idx} retry ${attempt}: ${error}`) }
 * ```
 */
export interface RetryConfig<TResult extends RetryableResult = RetryableResult> {
  /** Maximum retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial backoff in ms (default: 1000) */
  backoffMs?: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Custom retry condition (default: status === "error") */
  retryOn?: (result: TResult) => boolean;
  /** Callback invoked before each item retry attempt */
  onItemRetry?: OnItemRetryCallback;
}

/** Resolved retry config with all defaults applied (internal) */
interface ResolvedRetryConfig<TResult extends RetryableResult = RetryableResult> {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryOn: (result: TResult) => boolean;
}

/** Callback for item retry events */
export type OnItemRetryCallback = (itemIndex: number, attempt: number, error: string) => void;

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// RETRY LOGIC
// =============================================================================

/**
 * Execute a function with retry and exponential backoff.
 *
 * Works with any result type that has a `status` field (SwarmResult, ReduceResult, etc.).
 *
 * @param fn - Function that receives attempt number (1-based) and returns a result
 * @param config - Retry configuration (includes optional onRetry callback)
 * @param itemIndex - Item index for callback (default: 0, used for reduce)
 * @returns Result from the function
 *
 * @example
 * ```typescript
 * const result = await executeWithRetry(
 *   (attempt) => this.executeMapItem(item, prompt, index, operationId, params, timeout, attempt),
 *   { maxAttempts: 3, backoffMs: 1000, onItemRetry: (idx, attempt, error) => console.log(`Item ${idx} retry ${attempt}: ${error}`) },
 *   index
 * );
 * ```
 */
export async function executeWithRetry<TResult extends RetryableResult>(
  fn: (attempt: number) => Promise<TResult>,
  config?: RetryConfig<TResult>,
  itemIndex: number = 0
): Promise<TResult> {
  const resolved = resolveRetryConfig(config);
  const onItemRetry = config?.onItemRetry;

  let lastResult: TResult | null = null;
  let attempts = 0;
  let backoff = resolved.backoffMs;

  while (attempts < resolved.maxAttempts) {
    attempts++;
    lastResult = await fn(attempts);

    // Check if we should retry
    if (!resolved.retryOn(lastResult)) {
      return lastResult;
    }

    // Don't retry if we've exhausted attempts
    if (attempts >= resolved.maxAttempts) {
      break;
    }

    // Notify of retry
    if (onItemRetry) {
      const error = lastResult.error ?? "Unknown error";
      onItemRetry(itemIndex, attempts, error);
    }

    // Wait before retrying
    await sleep(backoff);
    backoff *= resolved.backoffMultiplier;
  }

  // Return last result
  return lastResult!;
}

/**
 * Resolve retry configuration with defaults (internal).
 */
function resolveRetryConfig<TResult extends RetryableResult = RetryableResult>(
  config?: RetryConfig<TResult>
): ResolvedRetryConfig<TResult> {
  return {
    maxAttempts: config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffMs: config?.backoffMs ?? DEFAULT_BACKOFF_MS,
    backoffMultiplier: config?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER,
    retryOn: config?.retryOn ?? ((r: TResult) => r.status === "error"),
  };
}
