"""Retry Utility for Swarm operations.

Generic retry with exponential backoff.
Works with any result type that has a status field.
"""

import asyncio
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, TypeVar

# =============================================================================
# CONSTANTS
# =============================================================================

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BACKOFF_MS = 1000
DEFAULT_BACKOFF_MULTIPLIER = 2.0

# =============================================================================
# TYPES
# =============================================================================

# TypeVar for result types (SwarmResult, ReduceResult, etc.)
# Results must have a `status` field for default retry behavior.
TResult = TypeVar('TResult')

# Callback type for item retry events (must be defined before RetryConfig)
OnItemRetryCallback = Callable[[int, int, str], None]  # (item_index, attempt, error)


def _get_field(obj: Any, field: str, default: Any = None) -> Any:
    """Get field from dict or object (duck typing helper)."""
    if isinstance(obj, dict):
        return obj.get(field, default)
    return getattr(obj, field, default)


@dataclass
class RetryConfig:
    """Per-item retry configuration.

    Example:
        # Basic retry on error
        RetryConfig(max_attempts=3)

        # With exponential backoff
        RetryConfig(max_attempts=3, backoff_ms=1000, backoff_multiplier=2)

        # Custom retry condition
        RetryConfig(max_attempts=3, retry_on=lambda r: r.status == "error" or "timeout" in (r.error or ""))

        # With callback
        RetryConfig(max_attempts=3, on_item_retry=lambda i, a, e: print(f"Item {i} retry {a}: {e}"))

    Args:
        max_attempts: Maximum retry attempts (default: 3)
        backoff_ms: Initial backoff in ms (default: 1000)
        backoff_multiplier: Exponential backoff multiplier (default: 2)
        retry_on: Custom retry condition (default: status == "error")
        on_item_retry: Callback when retry occurs (item_index, attempt, error)
    """
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    backoff_ms: int = DEFAULT_BACKOFF_MS
    backoff_multiplier: float = DEFAULT_BACKOFF_MULTIPLIER
    retry_on: Optional[Callable[[Any], bool]] = None
    on_item_retry: Optional[OnItemRetryCallback] = None

    def should_retry(self, result: Any) -> bool:
        """Check if result should be retried."""
        if self.retry_on is not None:
            return self.retry_on(result)
        # Default: retry on error status
        return _get_field(result, 'status') == "error"


# =============================================================================
# RETRY LOGIC
# =============================================================================

async def execute_with_retry(
    fn: Callable[[int], Awaitable[TResult]],
    config: Optional[RetryConfig] = None,
    item_index: int = 0,
) -> TResult:
    """Execute a function with retry and exponential backoff.

    Works with any result type that has a `status` field (SwarmResult, ReduceResult, etc.).

    Args:
        fn: Async function that receives attempt number (1-based) and returns a result
        config: Retry configuration (optional, uses defaults if not provided)
        item_index: Item index for callback (default: 0)

    Returns:
        Result from the function

    Example:
        result = await execute_with_retry(
            lambda attempt: self._execute_map_item(item, prompt, index, operation_id, params, timeout, attempt),
            RetryConfig(max_attempts=3, backoff_ms=1000),
            item_index=index,
        )
    """
    resolved = config or RetryConfig()

    last_result: Optional[TResult] = None
    attempts = 0
    backoff = resolved.backoff_ms

    while attempts < resolved.max_attempts:
        attempts += 1
        last_result = await fn(attempts)

        # Check if we should retry
        if not resolved.should_retry(last_result):
            return last_result

        # Don't retry if we've exhausted attempts
        if attempts >= resolved.max_attempts:
            break

        # Notify of retry via callback in config
        if resolved.on_item_retry is not None:
            error = _get_field(last_result, 'error') or "Unknown error"
            resolved.on_item_retry(item_index, attempts, error)

        # Wait before retrying (convert ms to seconds)
        await asyncio.sleep(backoff / 1000)
        backoff = backoff * resolved.backoff_multiplier

    # Return last result
    assert last_result is not None
    return last_result
