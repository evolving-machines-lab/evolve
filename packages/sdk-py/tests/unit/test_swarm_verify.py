#!/usr/bin/env python3
"""
Unit Test: Swarm Verify Feature

Tests that verify option works correctly across all abstractions:
- map() with verify: passes first attempt, retries with feedback, exhausts retries
- filter() with verify: works correctly
- reduce() with verify: works correctly with retries
- Concurrency is respected across workers and verifiers
- verify and bestOf are mutually exclusive

Uses mocked _execute() to avoid real sandbox/agent calls.

Usage:
  pytest tests/unit/test_swarm_verify.py -v
  python tests/unit/test_swarm_verify.py
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

from evolve import Swarm, SwarmConfig, BestOfConfig, VerifyConfig, RetryConfig
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
    is_verify: bool = False


@dataclass
class MockTracker:
    calls: List[ExecuteCall] = field(default_factory=list)
    concurrent: int = 0
    max_concurrent: int = 0
    call_order: List[str] = field(default_factory=list)
    verify_attempts_by_item: Dict[int, int] = field(default_factory=dict)
    worker_attempts_by_item: Dict[int, int] = field(default_factory=dict)


def create_mock_swarm_for_verify(
    concurrency: int,
    exec_delay: int = 15,
    verify_pass_on_attempt: int = 1,
    worker_failures: Optional[Dict[int, int]] = None,
) -> tuple:
    """Create a Swarm with mocked _execute for verify testing.

    Args:
        concurrency: Max concurrent executions
        exec_delay: Delay per execution in ms
        verify_pass_on_attempt: Verify passes on which attempt per item (1 = first try)
        worker_failures: Map of item index to number of worker failures before success
    """
    tracker = MockTracker()
    worker_failures = worker_failures or {}

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
        composio: Any = None,
        tag_prefix: str = "",
        timeout: int = 60000,
        observability: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # New tag format: test-map-0-verifier, test-filter-1-verifier, test-reduce-verifier
        is_verify = "-verifier" in tag_prefix

        call = ExecuteCall(
            tag_prefix=tag_prefix,
            start_time=time.time(),
            is_verify=is_verify,
        )
        tracker.calls.append(call)
        tracker.call_order.append(tag_prefix)

        tracker.concurrent += 1
        tracker.max_concurrent = max(tracker.max_concurrent, tracker.concurrent)

        # Simulate work
        await sleep_ms(exec_delay)

        tracker.concurrent -= 1
        call.end_time = time.time()

        if is_verify:
            # Extract item index from tag
            # Format: test-map-0-verifier or test-map-0-vr1-verifier
            # Look for pattern: -{operation}-{index}
            match = re.search(r'-(map|filter|reduce)-(\d+)', tag_prefix)
            item_index = int(match.group(2)) if match else 0

            # Track verify attempts per item
            current_attempt = tracker.verify_attempts_by_item.get(item_index, 0) + 1
            tracker.verify_attempts_by_item[item_index] = current_attempt

            # Verify passes on specified attempt
            should_pass = current_attempt >= verify_pass_on_attempt

            return {
                "files": {"result.json": '{"passed": ' + str(should_pass).lower() + '}'},
                "data": {
                    "passed": should_pass,
                    "reasoning": "Output meets criteria" if should_pass else "Needs improvement",
                    "feedback": None if should_pass else "Please fix the issues",
                },
                "tag": f"{tag_prefix}-abc123",
                "sandbox_id": "mock-sandbox-id",
            }

        # Regular worker execution
        # Extract item index from tag (e.g., test-map-0 or test-map-0-vr1)
        worker_match = re.search(r'-(map|filter|reduce)-(\d+)', tag_prefix)
        worker_item_index = int(worker_match.group(2)) if worker_match else 0

        # Track worker attempts per item
        worker_attempt = tracker.worker_attempts_by_item.get(worker_item_index, 0) + 1
        tracker.worker_attempts_by_item[worker_item_index] = worker_attempt

        # Check if worker should fail
        failures_remaining = worker_failures.get(worker_item_index, 0)
        if failures_remaining > 0:
            worker_failures[worker_item_index] = failures_remaining - 1
            return {
                "files": {},
                "data": None,
                "tag": f"{tag_prefix}-abc123",
                "sandbox_id": "mock-sandbox-id",
                "error": "Simulated worker failure",
            }

        if "judge" in tag_prefix:
            mock_data = {"winner": 0, "reasoning": "Mock reasoning"}
        elif schema:
            mock_data = {"mock": True, "score": 5, "value": 10}
        else:
            mock_data = {}

        return {
            "files": {"result.json": '{"mock": true}', "output.txt": "generated content"},
            "data": mock_data,
            "tag": f"{tag_prefix}-abc123",
            "sandbox_id": "mock-sandbox-id",
        }

    # Replace _execute with mock
    swarm._execute = mock_execute

    # Mock _ensure_bridge to prevent actual bridge initialization
    swarm._ensure_bridge = AsyncMock()

    return swarm, tracker


# =============================================================================
# VERIFY TESTS
# =============================================================================

async def test_map_with_verify_passes_first_try() -> None:
    print("\n[1] map() with verify: Passes on first attempt")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=1)

    items: List[FileMap] = [
        {"input1.txt": "content 1"},
        {"input2.txt": "content 2"},
    ]

    results = await swarm.map(
        items,
        "Process this",
        verify=VerifyConfig(criteria="Output must be valid", max_attempts=3),
    )

    # 2 worker calls + 2 verify calls = 4 total
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    # Both should succeed
    assert_test(len(results.success) == 2, f"Success count: {len(results.success)}, expected 2")

    # Verify info should be present
    assert_test(results[0].verify is not None, "First result should have verify info")
    assert_test(results[0].verify.passed is True, "First result verify should pass")
    assert_test(results[0].verify.attempts == 1, f"Attempts: {results[0].verify.attempts}, expected 1")

    # Concurrency respected
    assert_test(tracker.max_concurrent <= 2, f"Max concurrent was {tracker.max_concurrent}, expected <= 2")


async def test_map_with_verify_retries() -> None:
    print("\n[2] map() with verify: Retries on failure then passes")

    # Verify fails first time, passes second time
    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=2)

    items: List[FileMap] = [{"input.txt": "content"}]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Must be valid", max_attempts=3),
    )

    # Attempt 1: worker + verify(fail) = 2 calls
    # Attempt 2: worker + verify(pass) = 2 calls
    # Total: 4 calls
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    # Should succeed after retry
    assert_test(len(results.success) == 1, f"Success count: {len(results.success)}, expected 1")
    assert_test(results[0].verify.passed is True, "Verify should pass after retry")
    assert_test(results[0].verify.attempts == 2, f"Attempts: {results[0].verify.attempts}, expected 2")


async def test_map_with_verify_exhausts_retries() -> None:
    print("\n[3] map() with verify: Exhausts all retries")

    # Verify never passes (pass_on_attempt = 99)
    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=99)

    items: List[FileMap] = [{"input.txt": "content"}]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Must be valid", max_attempts=2),
    )

    # Attempt 1: worker + verify (fail) = 2 calls
    # Attempt 2: worker + verify (fail) = 2 calls
    # Total: 4 calls
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    # Result should show verify failed (status = error when max exceeded)
    assert_test(results[0].verify.passed is False, "Verify should show as failed")
    assert_test(results[0].verify.attempts == 2, f"Attempts: {results[0].verify.attempts}, expected 2")
    assert_test(results[0].status == "error", f"Status: {results[0].status}, expected error")


async def test_map_with_verify_concurrency() -> None:
    print("\n[4] map() with verify: Respects concurrency across workers and verifiers")

    swarm, tracker = create_mock_swarm_for_verify(3, 15, verify_pass_on_attempt=1)

    # 6 items with concurrency 3
    items: List[FileMap] = [{f"file{i}.txt": f"content {i}"} for i in range(6)]

    await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
    )

    # 6 workers + 6 verifies = 12 calls
    assert_test(len(tracker.calls) == 12, f"Total calls: {len(tracker.calls)}, expected 12")

    # Concurrency never exceeds 3
    assert_test(tracker.max_concurrent <= 3, f"Max concurrent was {tracker.max_concurrent}, expected <= 3")

    # Verify calls should be interleaved with worker calls
    verify_calls = [c for c in tracker.calls if c.is_verify]
    assert_test(len(verify_calls) == 6, f"Verify calls: {len(verify_calls)}, expected 6")


async def test_filter_with_verify() -> None:
    print("\n[5] filter() with verify: Works correctly")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=1)

    items: List[FileMap] = [
        {"a.txt": "a"},
        {"b.txt": "b"},
        {"c.txt": "c"},
    ]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    results = await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: (d.get("score", 0) if isinstance(d, dict) else getattr(d, "score", 0)) > 3,
        verify=VerifyConfig(criteria="Evaluation is accurate", max_attempts=2),
    )

    # 3 filter workers + 3 verifies = 6 calls
    assert_test(len(tracker.calls) == 6, f"Total calls: {len(tracker.calls)}, expected 6")

    # All should pass filter (mock returns score=5)
    assert_test(len(results.success) == 3, f"Success count: {len(results.success)}, expected 3")

    # Verify info present on results
    assert_test(results[0].verify is not None, "Filter results should have verify info")
    assert_test(results[0].verify.passed is True, "Filter verify should pass")


async def test_reduce_with_verify() -> None:
    print("\n[6] reduce() with verify: Works correctly")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=1)

    items: List[FileMap] = [
        {"1.txt": "one"},
        {"2.txt": "two"},
    ]

    result = await swarm.reduce(
        items,
        "Synthesize these",
        verify=VerifyConfig(criteria="Synthesis is complete", max_attempts=2),
    )

    # 1 reduce worker + 1 verify = 2 calls
    assert_test(len(tracker.calls) == 2, f"Total calls: {len(tracker.calls)}, expected 2")

    # Should succeed
    assert_test(result.status == "success", f"Status: {result.status}, expected success")
    assert_test(result.verify is not None, "Reduce result should have verify info")
    assert_test(result.verify.passed is True, "Verify should pass")


async def test_reduce_with_verify_retries() -> None:
    print("\n[7] reduce() with verify: Retries entire reduce on verify failure")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=2)

    items: List[FileMap] = [
        {"1.txt": "one"},
        {"2.txt": "two"},
    ]

    result = await swarm.reduce(
        items,
        "Synthesize",
        verify=VerifyConfig(criteria="Must be complete", max_attempts=3),
    )

    # Attempt 1: reduce + verify (fail) = 2 calls
    # Attempt 2: reduce + verify (pass) = 2 calls
    # Total: 4 calls
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    assert_test(result.status == "success", f"Status: {result.status}, expected success")
    assert_test(result.verify.attempts == 2, f"Verify attempts: {result.verify.attempts}, expected 2")


async def test_verify_best_of_mutually_exclusive() -> None:
    print("\n[8] map() with verify AND bestOf: Should be mutually exclusive")

    swarm, tracker = create_mock_swarm_for_verify(2)

    error_thrown = False
    error_message = ""
    try:
        await swarm.map(
            [{"test.txt": "content"}],
            "Process",
            verify=VerifyConfig(criteria="Valid"),
            best_of=BestOfConfig(n=2, judge_criteria="Best"),
        )
    except ValueError as e:
        error_thrown = True
        error_message = str(e)

    assert_test(error_thrown, "Should throw an error for verify + bestOf")
    assert_test(
        "simultaneously" in error_message.lower() or "both" in error_message.lower(),
        f"Error mentions mutual exclusivity: '{error_message}'"
    )


async def test_verify_with_standard_retry() -> None:
    print("\n[9] map() with verify AND retry: Both work together")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=1)

    items: List[FileMap] = [
        {"input1.txt": "content 1"},
        {"input2.txt": "content 2"},
    ]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
        retry=RetryConfig(max_attempts=2, backoff_ms=5),
    )

    # No worker failures in this test, so: 2 workers + 2 verifies = 4
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")
    assert_test(len(results.success) == 2, f"Success count: {len(results.success)}, expected 2")


async def test_map_with_verify_multiple_items() -> None:
    print("\n[10] map() with verify: Multiple items with different verify attempts")

    # Each item needs 2 verify attempts to pass
    swarm, tracker = create_mock_swarm_for_verify(4, 15, verify_pass_on_attempt=2)

    items: List[FileMap] = [{f"file{i}.txt": f"content {i}"} for i in range(4)]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    # Each item: 2 workers + 2 verifies = 4 calls
    # 4 items × 4 calls = 16 total
    assert_test(len(tracker.calls) == 16, f"Total calls: {len(tracker.calls)}, expected 16")

    # All should succeed
    assert_test(len(results.success) == 4, f"Success count: {len(results.success)}, expected 4")

    # Each should have 2 attempts
    for i in range(len(results)):
        assert_test(
            results[i].verify.attempts == 2,
            f"Item {i} attempts: {results[i].verify.attempts}, expected 2"
        )

    # Concurrency respected
    assert_test(tracker.max_concurrent <= 4, f"Max concurrent was {tracker.max_concurrent}, expected <= 4")


async def test_verify_ordering_worker_before_verifier() -> None:
    print("\n[11] Verify ordering: Worker always runs before its verifier")

    swarm, tracker = create_mock_swarm_for_verify(2, 20, verify_pass_on_attempt=1)

    items: List[FileMap] = [{"input.txt": "content"}]

    await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
    )

    # Find worker and verify calls
    worker_calls = [c for c in tracker.calls if not c.is_verify]
    verify_calls = [c for c in tracker.calls if c.is_verify]

    assert_test(len(worker_calls) == 1, f"Worker calls: {len(worker_calls)}, expected 1")
    assert_test(len(verify_calls) == 1, f"Verify calls: {len(verify_calls)}, expected 1")

    # Worker should complete before verify starts
    assert_test(
        worker_calls[0].end_time <= verify_calls[0].start_time,
        "Worker completed before verify started"
    )


async def test_filter_verify_then_condition() -> None:
    print("\n[12] filter() with verify: Condition applied after verification")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=1)

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    # Condition that always returns False - items should be "filtered"
    results = await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: False,  # Always filter out
        verify=VerifyConfig(criteria="Accurate", max_attempts=2),
    )

    # 2 workers + 2 verifies = 4 calls
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    # All should be filtered (not success, not error)
    assert_test(len(results.filtered) == 2, f"Filtered count: {len(results.filtered)}, expected 2")

    # Verify info still present on filtered results
    assert_test(results[0].verify is not None, "Filtered results should have verify info")


async def test_verify_high_load() -> None:
    print("\n[13] Stress Test: Many items with verify, concurrency respected")

    swarm, tracker = create_mock_swarm_for_verify(5, 10, verify_pass_on_attempt=1)

    # 20 items with concurrency 5
    items: List[FileMap] = [{f"file{i}.txt": f"content {i}"} for i in range(20)]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
    )

    # 20 workers + 20 verifies = 40 calls
    assert_test(len(tracker.calls) == 40, f"Total calls: {len(tracker.calls)}, expected 40")

    # All should succeed
    assert_test(len(results.success) == 20, f"Success count: {len(results.success)}, expected 20")

    # Concurrency NEVER exceeded
    assert_test(tracker.max_concurrent <= 5, f"Max concurrent was {tracker.max_concurrent}, expected <= 5")


async def test_verify_with_multiple_retries_concurrency() -> None:
    print("\n[14] map() with verify retries: Concurrency maintained during retry loop")

    # Verify passes on 3rd attempt
    swarm, tracker = create_mock_swarm_for_verify(3, 10, verify_pass_on_attempt=3)

    items: List[FileMap] = [{f"file{i}.txt": f"content {i}"} for i in range(3)]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    # Each item: 3 workers + 3 verifies = 6 calls
    # 3 items × 6 calls = 18 total
    assert_test(len(tracker.calls) == 18, f"Total calls: {len(tracker.calls)}, expected 18")

    # All should succeed
    assert_test(len(results.success) == 3, f"Success count: {len(results.success)}, expected 3")

    # All should have 3 attempts
    for i in range(len(results)):
        assert_test(
            results[i].verify.attempts == 3,
            f"Item {i} attempts: {results[i].verify.attempts}, expected 3"
        )

    # Concurrency never exceeded
    assert_test(tracker.max_concurrent <= 3, f"Max concurrent was {tracker.max_concurrent}, expected <= 3")


async def test_reduce_verify_max_attempts_exhausted() -> None:
    print("\n[15] reduce() with verify: Max retries exhausted returns error")

    swarm, tracker = create_mock_swarm_for_verify(2, 15, verify_pass_on_attempt=99)

    items: List[FileMap] = [{"1.txt": "one"}, {"2.txt": "two"}]

    result = await swarm.reduce(
        items,
        "Synthesize",
        verify=VerifyConfig(criteria="Must be complete", max_attempts=2),
    )

    # 2 reduce attempts + 2 verify attempts = 4 calls
    assert_test(len(tracker.calls) == 4, f"Total calls: {len(tracker.calls)}, expected 4")

    # Should be error
    assert_test(result.status == "error", f"Status: {result.status}, expected error")
    assert_test(result.verify.passed is False, "Verify should show as failed")
    assert_test(result.verify.attempts == 2, f"Attempts: {result.verify.attempts}, expected 2")


async def test_worker_error_retry_with_verify() -> None:
    print("\n[16] Worker error retry with verify: Worker fails, retries, succeeds, then verify runs")

    # Item 0: worker fails once then succeeds
    # Item 1: worker succeeds first try
    worker_failures = {0: 1}

    swarm, tracker = create_mock_swarm_for_verify(
        concurrency=2,
        exec_delay=10,
        verify_pass_on_attempt=1,
        worker_failures=worker_failures,
    )

    items: List[FileMap] = [
        {"input1.txt": "content 1"},
        {"input2.txt": "content 2"},
    ]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
        retry=RetryConfig(max_attempts=3, backoff_ms=5),
    )

    # Item 0: worker fail + worker success + verify = 3 calls
    # Item 1: worker success + verify = 2 calls
    # Total: 5 calls
    assert_test(len(tracker.calls) == 5, f"Total calls: {len(tracker.calls)}, expected 5")

    # Both should succeed
    assert_test(len(results.success) == 2, f"Success count: {len(results.success)}, expected 2")

    # Worker attempts: item 0 had 2 attempts, item 1 had 1 attempt
    assert_test(
        tracker.worker_attempts_by_item.get(0) == 2,
        f"Item 0 worker attempts: {tracker.worker_attempts_by_item.get(0)}, expected 2"
    )
    assert_test(
        tracker.worker_attempts_by_item.get(1) == 1,
        f"Item 1 worker attempts: {tracker.worker_attempts_by_item.get(1)}, expected 1"
    )

    # Verify should have run for both items
    verify_calls = [c for c in tracker.calls if c.is_verify]
    assert_test(len(verify_calls) == 2, f"Verify calls: {len(verify_calls)}, expected 2")

    # Both results should have verify info with passed=True
    assert_test(results[0].verify.passed is True, "Item 0 verify should pass")
    assert_test(results[1].verify.passed is True, "Item 1 verify should pass")


# =============================================================================
# MAIN
# =============================================================================

async def main() -> None:
    global passed, failed

    print("=" * 70)
    print("Swarm Verify Feature Tests (Python)")
    print("=" * 70)

    await test_map_with_verify_passes_first_try()
    await test_map_with_verify_retries()
    await test_map_with_verify_exhausts_retries()
    await test_map_with_verify_concurrency()
    await test_filter_with_verify()
    await test_reduce_with_verify()
    await test_reduce_with_verify_retries()
    await test_verify_best_of_mutually_exclusive()
    await test_verify_with_standard_retry()
    await test_map_with_verify_multiple_items()
    await test_verify_ordering_worker_before_verifier()
    await test_filter_verify_then_condition()
    await test_verify_high_load()
    await test_verify_with_multiple_retries_concurrency()
    await test_reduce_verify_max_attempts_exhausted()
    await test_worker_error_retry_with_verify()

    print("\n" + "=" * 70)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 70)

    if failed > 0:
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
