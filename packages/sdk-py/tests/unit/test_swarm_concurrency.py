#!/usr/bin/env python3
"""
Unit Test: Swarm Concurrency & Orchestration

Tests that Swarm correctly orchestrates operations with the Semaphore:
- Global concurrency limit is respected across all operations
- bestOf: judge runs only after all candidates complete
- map → reduce: reduce runs only after map completes
- map → filter: filter runs only after map completes
- Retry respects semaphore (permit released during backoff)

Uses mocked _execute() to avoid real sandbox/agent calls.

Usage:
  pytest tests/unit/test_swarm_concurrency.py -v
  python tests/unit/test_swarm_concurrency.py
"""

import asyncio
import os
import re
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))

from evolve import Swarm, SwarmConfig, RetryConfig
from evolve.swarm.types import FileMap

# =============================================================================
# TEST HELPERS
# =============================================================================

passed = 0
failed = 0


def assert_test(condition: bool, message: str) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ✓ {message}")
    else:
        failed += 1
        print(f"  ✗ {message}")


async def sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


# =============================================================================
# MOCK INFRASTRUCTURE
# =============================================================================

@dataclass
class ExecuteCall:
    tag_prefix: str
    start_time: float
    end_time: Optional[float] = None


@dataclass
class MockTracker:
    calls: List[ExecuteCall] = field(default_factory=list)
    concurrent: int = 0
    max_concurrent: int = 0
    call_order: List[str] = field(default_factory=list)
    attempt_counts: Dict[str, int] = field(default_factory=dict)


def create_mock_swarm(
    concurrency: int,
    exec_delay: int = 50,
    failures_per_item: Optional[Dict[str, int]] = None
) -> tuple:
    """Create a Swarm with mocked _execute method for testing."""
    tracker = MockTracker()
    failures = failures_per_item or {}

    config = SwarmConfig(
        tag="test",
        concurrency=concurrency,
    )
    swarm = Swarm(config)

    async def mock_execute(
        context: FileMap,
        prompt: str,
        system_prompt: Optional[str] = None,
        schema: Any = None,
        schema_options: Any = None,
        agent: Any = None,
        mcp_servers: Any = None,
        skills: Any = None,
        tag_prefix: str = "",
        timeout: int = 60000,
        observability: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # Extract base key without error retry suffix (e.g., "test-map-0-er2" → "test-map-0")
        item_key = re.sub(r'-er\d+$', '', tag_prefix)

        # Track attempt count
        current_attempt = tracker.attempt_counts.get(item_key, 0) + 1
        tracker.attempt_counts[item_key] = current_attempt

        call = ExecuteCall(tag_prefix=tag_prefix, start_time=time.time())
        tracker.calls.append(call)
        tracker.call_order.append(tag_prefix)

        tracker.concurrent += 1
        tracker.max_concurrent = max(tracker.max_concurrent, tracker.concurrent)

        # Simulate work
        await sleep_ms(exec_delay)

        tracker.concurrent -= 1
        call.end_time = time.time()

        # Check if this item should fail
        failures_remaining = failures.get(item_key, 0)
        if failures_remaining > 0:
            failures[item_key] = failures_remaining - 1
            return {
                "files": {},
                "data": None,
                "tag": f"{tag_prefix}-abc123",
                "sandbox_id": "mock-sandbox-id",
                "error": "Simulated failure",
            }

        # Return success - use appropriate mock data based on operation type
        if "judge" in tag_prefix:
            # Judge needs winner and reasoning
            mock_data = {"winner": 0, "reasoning": "Mock reasoning"}
        elif schema:
            mock_data = {"mock": True, "score": 5, "value": 10}
        else:
            mock_data = {}
        return {
            "files": {"result.json": '{"mock": true}'},
            "data": mock_data,
            "tag": f"{tag_prefix}-abc123",
            "sandbox_id": "mock-sandbox-id",
        }

    # Replace _execute with mock
    swarm._execute = mock_execute

    # Also need to mock _ensure_bridge to prevent actual bridge initialization
    swarm._ensure_bridge = AsyncMock()

    return swarm, tracker


# =============================================================================
# CONCURRENCY TESTS
# =============================================================================

async def test_map_concurrency() -> None:
    print("\n[1] map() Respects Global Concurrency")

    swarm, tracker = create_mock_swarm(4, 50)

    # map 10 items with concurrency 4
    items: List[FileMap] = [{f"file{i}.txt": f"content {i}"} for i in range(10)]

    await swarm.map(items, "Process this")

    assert_test(tracker.max_concurrent == 4, f"Max concurrent was {tracker.max_concurrent}, expected 4")
    assert_test(len(tracker.calls) == 10, f"Total calls: {len(tracker.calls)}, expected 10")


async def test_best_of_concurrency_and_ordering() -> None:
    print("\n[2] bestOf() Candidates Before Judge, Respects Concurrency")

    swarm, tracker = create_mock_swarm(3, 30)

    from evolve import BestOfConfig
    item: FileMap = {"input.txt": "test content"}

    await swarm.best_of(item, "Do the task", BestOfConfig(n=5, judge_criteria="Pick the best"))

    # Should have 5 candidates + 1 judge = 6 total calls
    assert_test(len(tracker.calls) == 6, f"Total calls: {len(tracker.calls)}, expected 6")

    # Max concurrent should be 3 (our limit), not 5
    assert_test(tracker.max_concurrent == 3, f"Max concurrent was {tracker.max_concurrent}, expected 3")

    # Judge should be LAST in call order
    judge_indices = [i for i, tag in enumerate(tracker.call_order) if "judge" in tag]
    if judge_indices:
        judge_index = judge_indices[0]
        assert_test(judge_index == 5, f"Judge was call #{judge_index + 1}, expected #6 (last)")

    # All candidates should complete before judge starts
    candidate_calls = [c for c in tracker.calls if "cand" in c.tag_prefix]
    judge_call = next((c for c in tracker.calls if "judge" in c.tag_prefix), None)

    if judge_call and candidate_calls:
        all_candidates_before_judge = all(c.end_time <= judge_call.start_time for c in candidate_calls)
        assert_test(all_candidates_before_judge, "All candidates completed before judge started")


async def test_map_with_best_of() -> None:
    print("\n[3] map() with bestOf: Complex Orchestration")

    swarm, tracker = create_mock_swarm(4, 20)

    from evolve import BestOfConfig

    # map 3 items, each with bestOf(3) = 3 * (3 candidates + 1 judge) = 12 total
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}, {"c.txt": "c"}]

    await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=3, judge_criteria="Pick best"),
    )

    # 3 items × (3 candidates + 1 judge) = 12 calls
    assert_test(len(tracker.calls) == 12, f"Total calls: {len(tracker.calls)}, expected 12")

    # Max concurrent should never exceed 4
    assert_test(tracker.max_concurrent <= 4, f"Max concurrent was {tracker.max_concurrent}, expected <= 4")

    # For each map item, its judge should come after its candidates
    for i in range(3):
        candidate_tags = [t for t in tracker.call_order if f"map-{i}-bestof-cand" in t]
        judge_tag = next((t for t in tracker.call_order if f"map-{i}-bestof-judge" in t), None)

        if judge_tag:
            candidate_indices = [tracker.call_order.index(t) for t in candidate_tags]
            judge_index = tracker.call_order.index(judge_tag)
            judge_after_candidates = all(ci < judge_index for ci in candidate_indices)
            assert_test(judge_after_candidates, f"map-{i}: judge after all its candidates")


async def test_map_then_reduce() -> None:
    print("\n[4] map() → reduce(): Sequential Orchestration")

    swarm, tracker = create_mock_swarm(4, 30)

    items: List[FileMap] = [
        {"1.txt": "one"},
        {"2.txt": "two"},
        {"3.txt": "three"},
        {"4.txt": "four"},
        {"5.txt": "five"},
    ]

    # Run map, then reduce
    mapped = await swarm.map(items, "Analyze")
    await swarm.reduce(mapped.success, "Synthesize")

    # 5 map + 1 reduce = 6 total
    assert_test(len(tracker.calls) == 6, f"Total calls: {len(tracker.calls)}, expected 6")

    # Reduce should be last
    reduce_call = next((c for c in tracker.calls if "reduce" in c.tag_prefix), None)
    map_calls = [c for c in tracker.calls if "map" in c.tag_prefix]

    if reduce_call and map_calls:
        reduce_after_all_maps = all(m.end_time <= reduce_call.start_time for m in map_calls)
        assert_test(reduce_after_all_maps, "Reduce started only after all map items completed")


async def test_map_then_filter() -> None:
    print("\n[5] map() → filter(): Sequential Orchestration")

    swarm, tracker = create_mock_swarm(3, 25)

    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}, {"c.txt": "c"}, {"d.txt": "d"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    # Run map, then filter
    mapped = await swarm.map(items, "Score this", schema=ScoreSchema)
    await swarm.filter(mapped.success, "Evaluate", schema=ScoreSchema, condition=lambda x: True)

    # 4 map + 4 filter = 8 total
    assert_test(len(tracker.calls) == 8, f"Total calls: {len(tracker.calls)}, expected 8")

    # All filter calls should start after all map calls complete
    map_calls = [c for c in tracker.calls if "map" in c.tag_prefix]
    filter_calls = [c for c in tracker.calls if "filter" in c.tag_prefix]

    if map_calls and filter_calls:
        last_map_end = max(c.end_time for c in map_calls)
        first_filter_start = min(c.start_time for c in filter_calls)
        assert_test(first_filter_start >= last_map_end, "Filter started only after all map items completed")


async def test_map_filter_reduce() -> None:
    print("\n[6] map() → filter() → reduce(): Full Pipeline")

    swarm, tracker = create_mock_swarm(2, 20)

    from pydantic import BaseModel
    class ValueSchema(BaseModel):
        value: int

    items: List[FileMap] = [{"1.txt": "1"}, {"2.txt": "2"}, {"3.txt": "3"}]

    # Full pipeline
    mapped = await swarm.map(items, "Extract", schema=ValueSchema)
    filtered = await swarm.filter(
        mapped.success, "Check", schema=ValueSchema,
        condition=lambda d: (d.get("value", 0) if isinstance(d, dict) else getattr(d, "value", 0)) > 0
    )
    await swarm.reduce(filtered.success, "Combine")

    # 3 map + 3 filter + 1 reduce = 7 total
    assert_test(len(tracker.calls) == 7, f"Total calls: {len(tracker.calls)}, expected 7")

    # Verify ordering: all map → all filter → reduce
    map_calls = [c for c in tracker.calls if "map" in c.tag_prefix]
    filter_calls = [c for c in tracker.calls if "filter" in c.tag_prefix]
    reduce_call = next((c for c in tracker.calls if "reduce" in c.tag_prefix), None)

    last_map_end = max(c.end_time for c in map_calls)
    first_filter_start = min(c.start_time for c in filter_calls)
    last_filter_end = max(c.end_time for c in filter_calls)

    assert_test(first_filter_start >= last_map_end, "Filter phase after map phase")
    assert_test(reduce_call.start_time >= last_filter_end, "Reduce after filter phase")

    # Max concurrent should never exceed 2
    assert_test(tracker.max_concurrent <= 2, f"Max concurrent was {tracker.max_concurrent}, expected <= 2")


async def test_map_best_of_then_filter() -> None:
    print("\n[7] map(bestOf) → filter(): Complex Pipeline")

    swarm, tracker = create_mock_swarm(3, 20)

    from evolve import BestOfConfig
    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}, {"c.txt": "c"}, {"d.txt": "d"}]

    # map with bestOf: 4 items × (3 candidates + 1 judge) = 16 calls
    mapped = await swarm.map(
        items,
        "Analyze",
        best_of=BestOfConfig(n=3, judge_criteria="Best analysis"),
        schema=ScoreSchema,
    )

    # Then filter: 4 more calls
    await swarm.filter(
        mapped.success, "Evaluate", schema=ScoreSchema,
        condition=lambda d: (d.get("score", 0) if isinstance(d, dict) else getattr(d, "score", 0)) > 0
    )

    # 16 map+bestOf + 4 filter = 20 total
    assert_test(len(tracker.calls) == 20, f"Total calls: {len(tracker.calls)}, expected 20")

    # Concurrency never exceeded
    assert_test(tracker.max_concurrent <= 3, f"Max concurrent was {tracker.max_concurrent}, expected <= 3")

    # All filter calls should start after all map+bestOf calls complete
    map_best_of_calls = [c for c in tracker.calls if "map" in c.tag_prefix]
    filter_calls = [c for c in tracker.calls if "filter" in c.tag_prefix]

    last_map_best_of_end = max(c.end_time for c in map_best_of_calls)
    first_filter_start = min(c.start_time for c in filter_calls)

    assert_test(first_filter_start >= last_map_best_of_end, "Filter started only after all map+bestOf completed")


async def test_map_best_of_filter_reduce() -> None:
    print("\n[8] map(bestOf) → filter() → reduce(): Full Complex Pipeline")

    swarm, tracker = create_mock_swarm(4, 15)

    from evolve import BestOfConfig
    from pydantic import BaseModel
    class ValueSchema(BaseModel):
        value: int

    items: List[FileMap] = [{"1.txt": "1"}, {"2.txt": "2"}, {"3.txt": "3"}]

    # map with bestOf: 3 items × (2 candidates + 1 judge) = 9 calls
    mapped = await swarm.map(
        items,
        "Extract",
        best_of=BestOfConfig(n=2, judge_criteria="Most accurate"),
        schema=ValueSchema,
    )

    # filter: 3 calls
    filtered = await swarm.filter(
        mapped.success, "Check", schema=ValueSchema,
        condition=lambda d: (d.get("value", 0) if isinstance(d, dict) else getattr(d, "value", 0)) > 0
    )

    # reduce: 1 call
    await swarm.reduce(filtered.success, "Combine")

    # 9 + 3 + 1 = 13 total
    assert_test(len(tracker.calls) == 13, f"Total calls: {len(tracker.calls)}, expected 13")

    # Concurrency never exceeded
    assert_test(tracker.max_concurrent <= 4, f"Max concurrent was {tracker.max_concurrent}, expected <= 4")

    # Verify phase ordering
    map_best_of_calls = [c for c in tracker.calls if "map" in c.tag_prefix]
    filter_calls = [c for c in tracker.calls if "filter" in c.tag_prefix]
    reduce_call = next((c for c in tracker.calls if "reduce" in c.tag_prefix), None)

    last_map_best_of_end = max(c.end_time for c in map_best_of_calls)
    first_filter_start = min(c.start_time for c in filter_calls)
    last_filter_end = max(c.end_time for c in filter_calls)

    assert_test(first_filter_start >= last_map_best_of_end, "Filter phase after map+bestOf phase")
    assert_test(reduce_call.start_time >= last_filter_end, "Reduce after filter phase")

    # Verify bestOf ordering within map phase (judge after candidates for each item)
    for i in range(3):
        candidate_tags = [t for t in tracker.call_order if f"map-{i}-bestof-cand" in t]
        judge_tag = next((t for t in tracker.call_order if f"map-{i}-bestof-judge" in t), None)

        if judge_tag:
            candidate_indices = [tracker.call_order.index(t) for t in candidate_tags]
            judge_index = tracker.call_order.index(judge_tag)
            judge_after_candidates = all(ci < judge_index for ci in candidate_indices)
            assert_test(judge_after_candidates, f"map-{i}: judge after all its candidates")


async def test_concurrency_never_exceeded() -> None:
    print("\n[9] Stress Test: Concurrency Never Exceeded")

    swarm, tracker = create_mock_swarm(5, 10)

    # Run multiple operations that would try to exceed concurrency
    items: List[FileMap] = [{f"{i}.txt": f"{i}"} for i in range(20)]

    # These all share the same semaphore
    await asyncio.gather(
        swarm.map(items[:10], "Map batch 1"),
        swarm.map(items[10:], "Map batch 2"),
    )

    assert_test(tracker.max_concurrent <= 5, f"Max concurrent was {tracker.max_concurrent}, expected <= 5")
    assert_test(len(tracker.calls) == 20, f"Total calls: {len(tracker.calls)}, expected 20")


# =============================================================================
# RETRY TESTS
# =============================================================================

async def test_map_retry_basic() -> None:
    print("\n[10] map() with Retry: Basic Retry on Error")

    # Item 0 fails twice then succeeds, item 1 succeeds first try
    failures = {"test-map-0": 2}
    swarm, tracker = create_mock_swarm(2, 20, failures)

    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    results = await swarm.map(
        items,
        "Process",
        retry=RetryConfig(max_attempts=3, backoff_ms=10),
    )

    # Item 0: 3 attempts (2 failures + 1 success), Item 1: 1 attempt
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4 (3 retries + 1 direct)")

    # Both should succeed in the end
    assert_test(len(results.success) == 2, f"Success count: {len(results.success)}, expected 2")

    # Concurrency still respected
    assert_test(tracker.max_concurrent <= 2, f"Max concurrent was {tracker.max_concurrent}, expected <= 2")


async def test_map_retry_respects_concurrency() -> None:
    print("\n[11] map() with Retry: Semaphore Released During Backoff")

    # All items fail once - this means during backoff, other items should run
    failures = {
        "test-map-0": 1,
        "test-map-1": 1,
        "test-map-2": 1,
        "test-map-3": 1,
    }
    swarm, tracker = create_mock_swarm(2, 15, failures)

    items: List[FileMap] = [{f"{i}.txt": f"{i}"} for i in range(4)]

    await swarm.map(
        items,
        "Process",
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # 4 items × 2 attempts = 8 calls
    assert_test(len(tracker.calls) == 8, f"Total calls: {len(tracker.calls)}, expected 8")

    # Concurrency should NEVER exceed 2 (even during retries)
    assert_test(tracker.max_concurrent <= 2, f"Max concurrent was {tracker.max_concurrent}, expected <= 2")


async def test_map_retry_exhausts_attempts() -> None:
    print("\n[12] map() with Retry: Exhausts All Attempts")

    # Item fails more times than maxAttempts allows
    failures = {"test-map-0": 5}  # Fails 5 times, but only 3 attempts allowed
    swarm, tracker = create_mock_swarm(2, 10, failures)

    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        retry=RetryConfig(max_attempts=3, backoff_ms=5),
    )

    # Should have made exactly 3 attempts
    assert_test(len(tracker.calls) == 3, f"Total calls: {len(tracker.calls)}, expected 3")

    # Should end in error (exhausted retries)
    assert_test(len(results.error) == 1, f"Error count: {len(results.error)}, expected 1")


async def test_filter_retry() -> None:
    print("\n[13] filter() with Retry: Retries on Error")

    failures = {"test-filter-1": 1}  # Second item fails once
    swarm, tracker = create_mock_swarm(2, 15, failures)

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}, {"c.txt": "c"}]

    results = await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: (d.get("score", 0) if isinstance(d, dict) else getattr(d, "score", 0)) > 3,
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # Item 0: 1, Item 1: 2 (retry), Item 2: 1 = 4 total
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    # All should succeed (filter passes all due to mock data score=5)
    assert_test(len(results.success) == 3, f"Success count: {len(results.success)}, expected 3")

    # Concurrency respected
    assert_test(tracker.max_concurrent <= 2, f"Max concurrent was {tracker.max_concurrent}, expected <= 2")


async def test_reduce_retry() -> None:
    print("\n[14] reduce() with Retry: Retries Entire Reduce")

    failures = {"test-reduce": 1}  # Reduce fails once
    swarm, tracker = create_mock_swarm(2, 15, failures)

    items: List[FileMap] = [{"1.txt": "one"}, {"2.txt": "two"}]

    result = await swarm.reduce(
        items,
        "Synthesize",
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # Reduce called twice (1 fail + 1 success)
    reduce_calls = [c for c in tracker.calls if "reduce" in c.tag_prefix]
    assert_test(len(reduce_calls) == 2, f"Reduce calls: {len(reduce_calls)}, expected 2")

    # Should succeed after retry
    assert_test(result.status == "success", f"Status: {result.status}, expected success")


async def test_best_of_retry() -> None:
    print("\n[15] bestOf() with Retry: Retries Failed Candidates")

    # Candidate 1 fails once
    failures = {"test-bestof-cand-1": 1}
    swarm, tracker = create_mock_swarm(3, 15, failures)

    from evolve import BestOfConfig
    item: FileMap = {"input.txt": "test"}

    result = await swarm.best_of(
        item,
        "Generate",
        config=BestOfConfig(n=3, judge_criteria="Best quality"),
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # 3 candidates (one retried once = 4) + 1 judge = 5 total
    assert_test(len(tracker.calls) == 5, f"Total calls: {len(tracker.calls)}, expected 5")

    # Winner should be selected
    assert_test(result.winner is not None, "Should have a winner")

    # Concurrency respected
    assert_test(tracker.max_concurrent <= 3, f"Max concurrent was {tracker.max_concurrent}, expected <= 3")


async def test_map_with_best_of_retry() -> None:
    print("\n[16] map(bestOf) with Retry: Per-Candidate Retries")

    # Each candidate that fails gets retried individually
    failures = {
        "test-map-0-bestof-cand-0": 1,  # First candidate of item 0 fails once
        "test-map-1-bestof-cand-1": 1,  # Second candidate of item 1 fails once
    }
    swarm, tracker = create_mock_swarm(3, 10, failures)

    from evolve import BestOfConfig
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    results = await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=2, judge_criteria="Best"),
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # Item 0: cand-0 (2 calls: fail+retry), cand-1 (1), judge (1) = 4
    # Item 1: cand-0 (1), cand-1 (2 calls: fail+retry), judge (1) = 4
    # Total = 8
    assert_test(len(tracker.calls) == 8, f"Total calls: {len(tracker.calls)}, expected 8")

    # All should succeed
    assert_test(len(results.success) == 2, f"Success count: {len(results.success)}, expected 2")

    # Concurrency never exceeded
    assert_test(tracker.max_concurrent <= 3, f"Max concurrent was {tracker.max_concurrent}, expected <= 3")


async def test_retry_with_high_concurrency() -> None:
    print("\n[17] Retry Stress Test: High Load with Failures")

    # Half the items fail once
    failures = {f"test-map-{i}": 1 for i in range(0, 10, 2)}
    swarm, tracker = create_mock_swarm(4, 10, failures)

    items: List[FileMap] = [{f"{i}.txt": f"{i}"} for i in range(10)]

    results = await swarm.map(
        items,
        "Process",
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # 5 items succeed first try, 5 items need retry = 15 total calls
    assert_test(len(tracker.calls) == 15, f"Total calls: {len(tracker.calls)}, expected 15")

    # All should succeed
    assert_test(len(results.success) == 10, f"Success count: {len(results.success)}, expected 10")

    # Concurrency NEVER exceeded (critical for retry correctness)
    assert_test(tracker.max_concurrent <= 4, f"Max concurrent was {tracker.max_concurrent}, expected <= 4")


async def test_retry_pipeline_concurrency() -> None:
    print("\n[18] map(retry) → filter(retry) → reduce(retry): Full Pipeline with Retries")

    failures = {
        "test-map-0": 1,
        "test-filter-1": 1,
        "test-reduce": 1,
    }
    swarm, tracker = create_mock_swarm(2, 10, failures)

    from pydantic import BaseModel
    class ValueSchema(BaseModel):
        value: int

    items: List[FileMap] = [{"1.txt": "1"}, {"2.txt": "2"}, {"3.txt": "3"}]

    retry_config = RetryConfig(max_attempts=2, backoff_ms=5)

    # Map with retry
    mapped = await swarm.map(items, "Extract", schema=ValueSchema, retry=retry_config)

    # Filter with retry
    filtered = await swarm.filter(
        mapped.success, "Check", schema=ValueSchema, condition=lambda x: True, retry=retry_config
    )

    # Reduce with retry
    result = await swarm.reduce(filtered.success, "Combine", retry=retry_config)

    # Map: 3 + 1 retry = 4
    # Filter: 3 + 1 retry = 4
    # Reduce: 1 + 1 retry = 2
    # Total: 10
    assert_test(len(tracker.calls) == 10, f"Total calls: {len(tracker.calls)}, expected 10")

    # Final result should succeed
    assert_test(result.status == "success", f"Final status: {result.status}, expected success")

    # Concurrency never exceeded throughout entire pipeline
    assert_test(tracker.max_concurrent <= 2, f"Max concurrent was {tracker.max_concurrent}, expected <= 2")


async def test_custom_retry_on() -> None:
    print("\n[19] Custom retryOn: Retry Based on Data Content")

    swarm, tracker = create_mock_swarm(2, 10)

    # Override execute to return custom data for item 0
    item0_attempts = {"count": 0}
    original_execute = swarm._execute

    async def custom_execute(*args, **kwargs):
        tag_prefix = kwargs.get("tag_prefix", "")
        if "map-0" in tag_prefix and "-r" not in tag_prefix:
            item0_attempts["count"] += 1
            if item0_attempts["count"] == 1:
                # Track call
                call = ExecuteCall(tag_prefix=tag_prefix, start_time=time.time())
                call.end_time = time.time()
                tracker.calls.append(call)
                tracker.call_order.append(tag_prefix)
                # First attempt: success status but data says needs retry
                return {
                    "files": {"result.json": '{"needsRetry": true, "value": 0}'},
                    "data": {"needsRetry": True, "value": 0},
                    "tag": f"{tag_prefix}-abc",
                    "sandbox_id": "mock",
                }
        return await original_execute(*args, **kwargs)

    swarm._execute = custom_execute

    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    results = await swarm.map(
        items,
        "Process",
        retry=RetryConfig(
            max_attempts=3,
            backoff_ms=5,
            retry_on=lambda r: r.status == "error" or (getattr(r, 'data', None) or {}).get("needsRetry") is True,
        ),
    )

    # Item 0: 2 attempts (first had needsRetry=true), Item 1: 1 attempt
    assert_test(len(tracker.calls) == 3, f"Total calls: {len(tracker.calls)}, expected 3")
    assert_test(len(results.success) == 2, f"Success count: {len(results.success)}, expected 2")


async def test_judge_retry_explicit() -> None:
    print("\n[20] bestOf() Judge Retry: Judge Fails Then Succeeds")

    # Judge fails once
    failures = {"test-bestof-judge": 1}
    swarm, tracker = create_mock_swarm(3, 10, failures)

    from evolve import BestOfConfig
    item: FileMap = {"input.txt": "test"}

    result = await swarm.best_of(
        item,
        "Generate",
        config=BestOfConfig(n=2, judge_criteria="Best"),
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # 2 candidates + 2 judge attempts (1 fail + 1 success) = 4
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")
    assert_test(result.winner is not None, "Should have a winner")


async def test_judge_ignores_custom_retry_on() -> None:
    print("\n[21] bestOf() Custom retryOn: Candidates Use It, Judge Ignores It")

    # Candidate 0 fails once, judge fails once
    # With retryOn: () => False, candidate should NOT retry
    # But judge should retry (uses default, ignores custom retryOn)
    failures = {
        "test-bestof-cand-0": 1,  # Candidate fails - should NOT retry (retryOn: false)
        "test-bestof-judge": 1,   # Judge fails - SHOULD retry (ignores retryOn)
    }
    swarm, tracker = create_mock_swarm(3, 10, failures)

    from evolve import BestOfConfig
    item: FileMap = {"input.txt": "test"}

    result = await swarm.best_of(
        item,
        "Generate",
        config=BestOfConfig(n=2, judge_criteria="Best"),
        retry=RetryConfig(
            max_attempts=2,
            backoff_ms=5,
            retry_on=lambda r: False,  # Never retry - but only applies to candidates
        ),
    )

    # Candidate 0: 1 call (fails, no retry due to retryOn: false)
    # Candidate 1: 1 call (succeeds)
    # Judge: 2 calls (fails, retries because it ignores retryOn)
    # Total: 4
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")
    assert_test(result.winner is not None, "Should have a winner after judge retry")

    # Verify candidate 0 did NOT retry (only 1 attempt)
    cand0_calls = [c for c in tracker.calls if "cand-0" in c.tag_prefix]
    assert_test(len(cand0_calls) == 1, f"Candidate 0 calls: {len(cand0_calls)}, expected 1 (no retry)")


async def test_map_best_of_judge_retry() -> None:
    print("\n[22] map(bestOf) Judge Retry: Judge Fails Then Succeeds")

    # Judge for item 0 fails once
    failures = {"test-map-0-bestof-judge": 1}
    swarm, tracker = create_mock_swarm(3, 10, failures)

    from evolve import BestOfConfig
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=2, judge_criteria="Best"),
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # 2 candidates + 2 judge attempts = 4
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")
    assert_test(len(results.success) == 1, f"Success count: {len(results.success)}, expected 1")


async def test_high_load_best_of() -> None:
    print("\n[23] High Load: map(10) with bestOf(5), concurrency=4")

    swarm, tracker = create_mock_swarm(4, 15)

    from evolve import BestOfConfig

    # 10 items × (5 candidates + 1 judge) = 60 total calls
    items: List[FileMap] = [{f"{i}.txt": f"{i}"} for i in range(10)]

    await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=5, judge_criteria="Best quality"),
    )

    # 10 × 6 = 60 calls
    assert_test(len(tracker.calls) == 60, f"Total calls: {len(tracker.calls)}, expected 60")

    # Never exceed concurrency limit
    assert_test(tracker.max_concurrent == 4, f"Max concurrent was {tracker.max_concurrent}, expected 4")


# =============================================================================
# MAIN
# =============================================================================

async def main() -> None:
    global passed, failed

    print("=" * 70)
    print("Swarm Concurrency & Orchestration Tests (Python)")
    print("=" * 70)

    # Concurrency tests
    await test_map_concurrency()
    await test_best_of_concurrency_and_ordering()
    await test_map_with_best_of()
    await test_map_then_reduce()
    await test_map_then_filter()
    await test_map_filter_reduce()
    await test_map_best_of_then_filter()
    await test_map_best_of_filter_reduce()
    await test_concurrency_never_exceeded()
    await test_high_load_best_of()

    # Retry tests
    await test_map_retry_basic()
    await test_map_retry_respects_concurrency()
    await test_map_retry_exhausts_attempts()
    await test_filter_retry()
    await test_reduce_retry()
    await test_best_of_retry()
    await test_map_with_best_of_retry()
    await test_retry_with_high_concurrency()
    await test_retry_pipeline_concurrency()
    await test_custom_retry_on()
    await test_judge_retry_explicit()
    await test_judge_ignores_custom_retry_on()
    await test_map_best_of_judge_retry()

    print("\n" + "=" * 70)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 70)

    if failed > 0:
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
