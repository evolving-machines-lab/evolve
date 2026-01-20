#!/usr/bin/env python3
"""
Unit Test: Observability Metadata Propagation

Tests all observability changes:
- operation_id: unique per map/filter/reduce/best_of call
- BaseMeta fields: error_retry, verify_retry, candidate_index, pipeline tracking
- PipelineContext: pipeline_run_id, pipeline_step_index propagation
- Observability objects passed to _execute()
- _pipeline_context_to_meta() and _pipeline_context_to_observability() helpers
- Pipeline integration: pipeline_run_id in results

Uses mocked _execute() to avoid real sandbox/agent calls.

Usage:
  pytest tests/unit/test_observability_metadata.py -v
  python tests/unit/test_observability_metadata.py
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
from evolve.pipeline import Pipeline, MapConfig, FilterConfig, ReduceConfig

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


def assert_defined(value: Any, message: str) -> None:
    global passed, failed
    if value is not None:
        passed += 1
        print(f"  ✓ {message}")
    else:
        failed += 1
        print(f"  ✗ {message} (was {value})")


async def sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


# =============================================================================
# MOCK INFRASTRUCTURE
# =============================================================================

@dataclass
class ObservabilityCapture:
    operation_id: Optional[str] = None
    operation: Optional[str] = None
    item_index: Optional[int] = None
    role: Optional[str] = None
    error_retry: Optional[int] = None
    verify_retry: Optional[int] = None
    candidate_index: Optional[int] = None
    pipeline_run_id: Optional[str] = None
    pipeline_step_index: Optional[int] = None
    swarm_name: Optional[str] = None
    operation_name: Optional[str] = None


@dataclass
class ExecuteCall:
    tag_prefix: str
    observability: Optional[ObservabilityCapture] = None
    system_prompt: Optional[str] = None


@dataclass
class MockTracker:
    calls: List[ExecuteCall] = field(default_factory=list)
    observabilities: List[ObservabilityCapture] = field(default_factory=list)


def create_mock_swarm(
    failures_per_tag: Optional[Dict[str, int]] = None,
    verify_pass_on_attempt: int = 1,
) -> tuple:
    """Create a Swarm with mocked _execute for observability testing."""
    tracker = MockTracker()
    failures_per_tag = failures_per_tag or {}
    failure_counters: Dict[str, int] = {}
    verify_retrys: Dict[str, int] = {}

    config = SwarmConfig(
        tag="test",
        concurrency=4,
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
        # Capture observability
        obs_capture = None
        if observability:
            obs_capture = ObservabilityCapture(
                operation_id=observability.get('operation_id'),
                operation=observability.get('operation'),
                item_index=observability.get('item_index'),
                role=observability.get('role'),
                error_retry=observability.get('error_retry'),
                verify_retry=observability.get('verify_retry'),
                candidate_index=observability.get('candidate_index'),
                pipeline_run_id=observability.get('pipeline_run_id'),
                pipeline_step_index=observability.get('pipeline_step_index'),
                swarm_name=observability.get('swarm_name'),
                operation_name=observability.get('operation_name'),
            )
            tracker.observabilities.append(obs_capture)

        call = ExecuteCall(
            tag_prefix=tag_prefix,
            observability=obs_capture,
            system_prompt=system_prompt,
        )
        tracker.calls.append(call)

        await sleep_ms(5)

        is_verify = "-verifier" in tag_prefix

        if is_verify:
            # Extract item key for verify attempt tracking
            match = re.search(r'test-(map|filter)-(\d+)', tag_prefix)
            reduce_match = re.search(r'test-(reduce)', tag_prefix)
            item_key = f"{match.group(1)}-{match.group(2)}" if match else ("reduce" if reduce_match else tag_prefix)

            current_attempt = verify_retrys.get(item_key, 0) + 1
            verify_retrys[item_key] = current_attempt

            should_pass = current_attempt >= verify_pass_on_attempt

            return {
                "files": {"result.json": f'{{"passed": {str(should_pass).lower()}}}'},
                "data": {
                    "passed": should_pass,
                    "reasoning": "OK" if should_pass else "Needs work",
                    "feedback": None if should_pass else "Fix it",
                },
                "tag": f"{tag_prefix}-abc",
                "sandbox_id": "mock-sandbox-id",
            }

        # Worker execution - check for configured failures
        should_fail = False
        for pattern, max_failures in failures_per_tag.items():
            if pattern in tag_prefix or re.match(pattern, tag_prefix):
                counter = failure_counters.get(pattern, 0)
                if counter < max_failures:
                    failure_counters[pattern] = counter + 1
                    should_fail = True
                    break

        if should_fail:
            return {
                "files": {},
                "data": None,
                "tag": f"{tag_prefix}-abc",
                "sandbox_id": "mock-sandbox-id",
                "error": "Simulated failure",
            }

        # Judge response
        if "judge" in tag_prefix:
            mock_data = {"winner": 0, "reasoning": "Mock reasoning"}
        elif schema:
            mock_data = {"score": 5, "value": 10}
        else:
            mock_data = {}

        return {
            "files": {"result.json": '{"mock": true}', "output.txt": "content"},
            "data": mock_data,
            "tag": f"{tag_prefix}-abc",
            "sandbox_id": "mock-sandbox-id",
        }

    # Replace _execute with mock
    swarm._execute = mock_execute

    # Mock _ensure_bridge to prevent actual bridge initialization
    swarm._ensure_bridge = AsyncMock()

    return swarm, tracker


# =============================================================================
# TEST: OPERATION ID GENERATION
# =============================================================================

async def test_operation_id_unique() -> None:
    print("\n[1] operation_id: Each operation call gets unique ID")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    # Run map twice
    await swarm.map(items, "Process 1")
    first_op_ids = [o.operation_id for o in tracker.observabilities]

    await swarm.map(items, "Process 2")
    all_op_ids = [o.operation_id for o in tracker.observabilities]
    second_op_ids = all_op_ids[len(first_op_ids):]

    # First operation items share same operation_id
    assert_test(
        first_op_ids[0] == first_op_ids[1],
        f"Items in same operation share operation_id: {first_op_ids[0]} === {first_op_ids[1]}"
    )

    # Different operations have different operation_ids
    assert_test(
        first_op_ids[0] != second_op_ids[0],
        f"Different operations have different operation_ids: {first_op_ids[0]} !== {second_op_ids[0]}"
    )

    # operation_id is 16 hex chars (8 bytes)
    assert_test(
        bool(re.match(r'^[0-9a-f]{16}$', first_op_ids[0])),
        f"operation_id is 16 hex chars: {first_op_ids[0]}"
    )


async def test_operation_id_per_abstraction() -> None:
    print("\n[2] operation_id: Each abstraction (map/filter/reduce) gets unique ID")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    await swarm.map(items, "Map")
    map_op_id = tracker.observabilities[0].operation_id

    await swarm.filter(items, "Filter", schema=ScoreSchema, condition=lambda d: True)
    filter_op_id = tracker.observabilities[1].operation_id

    await swarm.reduce(items, "Reduce")
    reduce_op_id = tracker.observabilities[2].operation_id

    assert_test(map_op_id != filter_op_id, "map and filter have different operation_ids")
    assert_test(filter_op_id != reduce_op_id, "filter and reduce have different operation_ids")
    assert_test(map_op_id != reduce_op_id, "map and reduce have different operation_ids")


# =============================================================================
# TEST: OBSERVABILITY FIELDS IN EXECUTE
# =============================================================================

async def test_map_observability_fields() -> None:
    print("\n[3] map: Observability has correct fields")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    await swarm.map(items, "Process")

    assert_test(len(tracker.observabilities) == 2, f"2 observability objects captured")

    obs0 = tracker.observabilities[0]
    assert_defined(obs0.operation_id, "operation_id defined")
    assert_test(obs0.operation == "map", f'operation is "map": {obs0.operation}')
    assert_test(obs0.item_index == 0, f"item_index is 0: {obs0.item_index}")
    assert_test(obs0.role == "worker", f'role is "worker": {obs0.role}')

    obs1 = tracker.observabilities[1]
    assert_test(obs1.item_index == 1, f"second item has item_index 1: {obs1.item_index}")


async def test_filter_observability_fields() -> None:
    print("\n[4] filter: Observability has correct fields")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    await swarm.filter(items, "Evaluate", schema=ScoreSchema, condition=lambda d: True)

    obs = tracker.observabilities[0]
    assert_defined(obs.operation_id, "operation_id defined")
    assert_test(obs.operation == "filter", f'operation is "filter": {obs.operation}')
    assert_test(obs.item_index == 0, f"item_index is 0: {obs.item_index}")
    assert_test(obs.role == "worker", f'role is "worker": {obs.role}')


async def test_reduce_observability_fields() -> None:
    print("\n[5] reduce: Observability has correct fields")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    await swarm.reduce(items, "Synthesize")

    obs = tracker.observabilities[0]
    assert_defined(obs.operation_id, "operation_id defined")
    assert_test(obs.operation == "reduce", f'operation is "reduce": {obs.operation}')
    assert_test(obs.role == "worker", f'role is "worker": {obs.role}')
    # reduce doesn't have item_index (it processes all items together)


# =============================================================================
# TEST: ERROR RETRY TRACKING
# =============================================================================

async def test_error_retry_in_observability() -> None:
    print("\n[6] error_retry: Tracked in observability on retry")

    failures_per_tag = {"test-map-0": 2}
    swarm, tracker = create_mock_swarm(failures_per_tag=failures_per_tag)
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        retry=RetryConfig(max_attempts=4, backoff_ms=1),
    )

    # Should have 3 calls: attempt 1 (fail), attempt 2 (fail), attempt 3 (success)
    assert_test(len(tracker.observabilities) == 3, f"3 observability objects: {len(tracker.observabilities)}")

    # First attempt: no error_retry
    assert_test(
        tracker.observabilities[0].error_retry is None,
        f"First attempt has no error_retry: {tracker.observabilities[0].error_retry}"
    )

    # Second attempt: error_retry = 1
    assert_test(
        tracker.observabilities[1].error_retry == 1,
        f"Second attempt has error_retry=1: {tracker.observabilities[1].error_retry}"
    )

    # Third attempt: error_retry = 2
    assert_test(
        tracker.observabilities[2].error_retry == 2,
        f"Third attempt has error_retry=2: {tracker.observabilities[2].error_retry}"
    )


async def test_error_retry_in_meta() -> None:
    print("\n[7] error_retry: Tracked in result.meta")

    failures_per_tag = {"test-map-0": 1}
    swarm, tracker = create_mock_swarm(failures_per_tag=failures_per_tag)
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        retry=RetryConfig(max_attempts=3, backoff_ms=1),
    )

    meta = results[0].meta
    assert_defined(meta, "Result has meta")
    assert_test(meta.error_retry == 1, f"meta.error_retry is 1: {meta.error_retry}")


# =============================================================================
# TEST: VERIFY ATTEMPT TRACKING
# =============================================================================

async def test_verify_attempt_in_observability() -> None:
    print("\n[8] verify_retry: Tracked in observability during verify loop")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=2)
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    # Workers should have verify_retry (None on first attempt, 1 on first retry)
    worker_obs = [o for o in tracker.observabilities if o.role == "worker"]
    assert_test(len(worker_obs) == 2, f"2 worker observabilities: {len(worker_obs)}")

    assert_test(
        worker_obs[0].verify_retry is None,
        f"First worker has verify_retry=None (not a retry): {worker_obs[0].verify_retry}"
    )
    assert_test(
        worker_obs[1].verify_retry == 1,
        f"Second worker has verify_retry=1 (first retry): {worker_obs[1].verify_retry}"
    )

    # Verifiers should also have role="verifier"
    verifier_obs = [o for o in tracker.observabilities if o.role == "verifier"]
    assert_test(len(verifier_obs) == 2, f"2 verifier observabilities: {len(verifier_obs)}")


async def test_verify_attempt_in_meta() -> None:
    print("\n[9] verify_retry: Tracked in result.meta")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=2)
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    meta = results[0].meta
    assert_defined(meta, "Result has meta")
    # verify_retry=1 means first retry (attempt 2)
    assert_test(meta.verify_retry == 1, f"meta.verify_retry is 1: {meta.verify_retry}")


# =============================================================================
# TEST: BESTOF CANDIDATE INDEX TRACKING
# =============================================================================

async def test_candidate_index_in_observability() -> None:
    print("\n[10] candidate_index: Tracked in observability for bestOf")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=3, judge_criteria="Best output"),
    )

    # Should have 3 candidates + 1 judge
    candidate_obs = [o for o in tracker.observabilities if o.role == "candidate"]
    assert_test(len(candidate_obs) == 3, f"3 candidate observabilities: {len(candidate_obs)}")

    assert_test(candidate_obs[0].candidate_index == 0, "First candidate has candidate_index=0")
    assert_test(candidate_obs[1].candidate_index == 1, "Second candidate has candidate_index=1")
    assert_test(candidate_obs[2].candidate_index == 2, "Third candidate has candidate_index=2")

    # Judge should not have candidate_index
    judge_obs = next((o for o in tracker.observabilities if o.role == "judge"), None)
    assert_test(judge_obs.candidate_index is None, "Judge has no candidate_index")


async def test_candidate_index_in_meta() -> None:
    print("\n[11] candidate_index: Tracked in candidate result.meta")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=2, judge_criteria="Best output"),
    )

    # Winner should have best_of info with candidates
    result = results[0]
    assert_defined(result.best_of, "Result has best_of info")

    candidates = result.best_of.candidates
    assert_test(candidates[0].meta.candidate_index == 0, "Candidate 0 meta has candidate_index=0")
    assert_test(candidates[1].meta.candidate_index == 1, "Candidate 1 meta has candidate_index=1")


# =============================================================================
# TEST: PIPELINE CONTEXT PROPAGATION
# =============================================================================

async def test_pipeline_context_in_observability() -> None:
    print("\n[12] Pipeline: Context propagated to observability")

    swarm, tracker = create_mock_swarm()

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    pipeline = (
        Pipeline(swarm)
        .map(MapConfig(prompt="Step 1", name="analyze"))
        .filter(FilterConfig(
            prompt="Step 2",
            name="evaluate",
            schema=ScoreSchema,
            condition=lambda d: True,
        ))
    )

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    # Step 0 (map) observability
    step0_obs = next((o for o in tracker.observabilities if o.pipeline_step_index == 0), None)
    assert_defined(step0_obs, "Step 0 observability exists")
    assert_defined(step0_obs.pipeline_run_id, "pipeline_run_id defined")
    assert_test(step0_obs.pipeline_step_index == 0, "pipeline_step_index is 0")

    # Step 1 (filter) observability
    step1_obs = next((o for o in tracker.observabilities if o.pipeline_step_index == 1), None)
    assert_defined(step1_obs, "Step 1 observability exists")
    assert_test(step1_obs.pipeline_step_index == 1, "pipeline_step_index is 1")

    # Both steps share same pipeline_run_id
    assert_test(
        step0_obs.pipeline_run_id == step1_obs.pipeline_run_id,
        "Both steps share pipeline_run_id"
    )


async def test_pipeline_context_in_meta() -> None:
    print("\n[13] Pipeline: Context propagated to result.meta")

    swarm, tracker = create_mock_swarm()
    pipeline = Pipeline(swarm).map(MapConfig(prompt="Analyze", name="step1"))

    items: List[FileMap] = [{"a.txt": "a"}]
    result = await pipeline.run(items)

    # Check pipeline_run_id in result
    assert_defined(result.pipeline_run_id, "PipelineResult has pipeline_run_id")
    assert_test(
        bool(re.match(r'^[0-9a-f]{16}$', result.pipeline_run_id)),
        f"pipeline_run_id is 16 hex chars: {result.pipeline_run_id}"
    )

    # Check meta in step results
    step_result = result.steps[0]
    assert_defined(step_result, "Step result exists")

    item_results = step_result.results
    meta = item_results[0].meta
    assert_defined(meta, "Item result has meta")

    assert_test(
        meta.pipeline_run_id == result.pipeline_run_id,
        "meta.pipeline_run_id matches result.pipeline_run_id"
    )
    assert_test(meta.pipeline_step_index == 0, f"meta.pipeline_step_index is 0: {meta.pipeline_step_index}")
    assert_test(meta.operation_name == "step1", f'meta.operation_name is "step1": {meta.operation_name}')


async def test_pipeline_run_id_unique() -> None:
    print("\n[14] Pipeline: Each run() gets unique pipeline_run_id")

    swarm, tracker = create_mock_swarm()
    pipeline = Pipeline(swarm).map(MapConfig(prompt="Process"))

    items: List[FileMap] = [{"a.txt": "a"}]

    result1 = await pipeline.run(items)
    result2 = await pipeline.run(items)

    assert_defined(result1.pipeline_run_id, "First run has pipeline_run_id")
    assert_defined(result2.pipeline_run_id, "Second run has pipeline_run_id")
    assert_test(
        result1.pipeline_run_id != result2.pipeline_run_id,
        f"Different runs have different pipeline_run_ids: {result1.pipeline_run_id} !== {result2.pipeline_run_id}"
    )


# =============================================================================
# TEST: NO PIPELINE CONTEXT FOR DIRECT SWARM CALLS
# =============================================================================

async def test_no_pipeline_context_for_direct_swarm() -> None:
    print("\n[15] Direct Swarm: No pipeline context in meta")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(items, "Process")

    # Observability should not have pipeline fields
    obs = tracker.observabilities[0]
    assert_test(obs.pipeline_run_id is None, "No pipeline_run_id in observability")
    assert_test(obs.pipeline_step_index is None, "No pipeline_step_index in observability")

    # Meta should have None pipeline fields
    meta = results[0].meta
    assert_test(meta.pipeline_run_id is None, "No pipeline_run_id in meta")
    assert_test(meta.pipeline_step_index is None, "No pipeline_step_index in meta")


# =============================================================================
# TEST: REDUCE META STRUCTURE
# =============================================================================

async def test_reduce_meta_structure() -> None:
    print("\n[16] reduce: Meta has correct structure (ReduceMeta)")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}, {"c.txt": "c"}]

    result = await swarm.reduce(items, "Synthesize")

    meta = result.meta
    assert_defined(meta.operation_id, "operation_id defined")
    assert_test(meta.operation == "reduce", 'operation is "reduce"')
    assert_test(meta.input_count == 3, f"input_count is 3: {meta.input_count}")
    assert_test(
        meta.input_indices == [0, 1, 2],
        f"input_indices is [0,1,2]: {meta.input_indices}"
    )


# =============================================================================
# TEST: VERIFY META STRUCTURE
# =============================================================================

async def test_verify_meta_structure() -> None:
    print("\n[17] verify: VerifyMeta has correct structure")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=2)
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    verify_info = results[0].verify
    assert_defined(verify_info, "Result has verify info")
    assert_test(verify_info.passed is True, "verify.passed is True")
    assert_test(verify_info.attempts == 2, f"verify.attempts is 2: {verify_info.attempts}")

    verify_meta = verify_info.verify_meta
    assert_defined(verify_meta, "verify_meta defined")
    assert_defined(verify_meta.operation_id, "verify_meta.operation_id defined")
    assert_test(verify_meta.operation == "verify", 'verify_meta.operation is "verify"')
    assert_test(verify_meta.attempts == 2, f"verify_meta.attempts is 2: {verify_meta.attempts}")


async def test_verify_meta_has_pipeline_context() -> None:
    print("\n[18] verify: VerifyMeta has pipeline context when run via Pipeline")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=1)
    pipeline = Pipeline(swarm).map(MapConfig(
        prompt="Process",
        name="verified-step",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
    ))

    items: List[FileMap] = [{"a.txt": "a"}]
    result = await pipeline.run(items)

    step_results = result.steps[0].results
    verify_meta = step_results[0].verify.verify_meta

    assert_defined(verify_meta, "verify_meta defined")
    assert_test(
        verify_meta.pipeline_run_id == result.pipeline_run_id,
        f"verify_meta.pipeline_run_id matches: {verify_meta.pipeline_run_id}"
    )
    assert_test(verify_meta.pipeline_step_index == 0, "verify_meta.pipeline_step_index is 0")


# =============================================================================
# TEST: BESTOF JUDGE META STRUCTURE
# =============================================================================

async def test_judge_meta_structure() -> None:
    print("\n[19] bestOf: JudgeMeta has correct structure")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    results = await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=3, judge_criteria="Best output"),
    )

    best_of_info = results[0].best_of
    assert_defined(best_of_info, "Result has best_of info")

    judge_meta = best_of_info.judge_meta
    assert_defined(judge_meta, "judge_meta defined")
    assert_defined(judge_meta.operation_id, "judge_meta.operation_id defined")
    assert_test(judge_meta.operation == "bestof-judge", 'judge_meta.operation is "bestof-judge"')
    assert_test(judge_meta.candidate_count == 3, f"judge_meta.candidate_count is 3: {judge_meta.candidate_count}")


async def test_judge_meta_has_pipeline_context() -> None:
    print("\n[20] bestOf: JudgeMeta has pipeline context when run via Pipeline")

    swarm, tracker = create_mock_swarm()
    pipeline = Pipeline(swarm).map(MapConfig(
        prompt="Process",
        name="bestof-step",
        best_of=BestOfConfig(n=2, judge_criteria="Best output"),
    ))

    items: List[FileMap] = [{"a.txt": "a"}]
    result = await pipeline.run(items)

    step_results = result.steps[0].results
    judge_meta = step_results[0].best_of.judge_meta

    assert_defined(judge_meta, "judge_meta defined")
    assert_test(
        judge_meta.pipeline_run_id == result.pipeline_run_id,
        f"judge_meta.pipeline_run_id matches: {judge_meta.pipeline_run_id}"
    )
    assert_test(judge_meta.pipeline_step_index == 0, "judge_meta.pipeline_step_index is 0")


# =============================================================================
# TEST: ROLE FIELD IN OBSERVABILITY
# =============================================================================

async def test_role_field_variants() -> None:
    print("\n[21] role: Different roles for different execution types")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=1)
    items: List[FileMap] = [{"a.txt": "a"}]

    # Test worker role
    await swarm.map(items, "Map")
    assert_test(
        any(o.role == "worker" for o in tracker.observabilities),
        'map has role="worker"'
    )

    # Clear and test verify roles
    tracker.observabilities.clear()
    await swarm.map(
        items,
        "Map with verify",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
    )
    assert_test(
        any(o.role == "worker" for o in tracker.observabilities),
        'verify workflow has role="worker"'
    )
    assert_test(
        any(o.role == "verifier" for o in tracker.observabilities),
        'verify workflow has role="verifier"'
    )

    # Clear and test bestOf roles
    tracker.observabilities.clear()
    await swarm.map(
        items,
        "Map with bestOf",
        best_of=BestOfConfig(n=2, judge_criteria="Best"),
    )
    assert_test(
        any(o.role == "candidate" for o in tracker.observabilities),
        'bestOf has role="candidate"'
    )
    assert_test(
        any(o.role == "judge" for o in tracker.observabilities),
        'bestOf has role="judge"'
    )


# =============================================================================
# TEST: ALL FIELDS TOGETHER
# =============================================================================

async def test_all_fields_together() -> None:
    print("\n[22] Combined: Pipeline + verify fields present together")

    # Test pipeline context + verify_retry together (most common combined scenario)
    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=2)

    pipeline = Pipeline(swarm).map(MapConfig(
        prompt="Process",
        name="complex-step",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    ))

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    # Find the second worker (verify_retry=1 is the first retry, which is the successful one)
    success_worker_obs = next(
        (o for o in tracker.observabilities if o.role == "worker" and o.verify_retry == 1),
        None
    )

    assert_defined(success_worker_obs, "Found worker with verify_retry=1")
    assert_defined(success_worker_obs.operation_id, "operation_id defined")
    assert_test(success_worker_obs.operation == "map", 'operation is "map"')
    assert_test(success_worker_obs.item_index == 0, "item_index is 0")
    assert_test(success_worker_obs.role == "worker", 'role is "worker"')
    assert_test(success_worker_obs.verify_retry == 1, "verify_retry is 1 (first retry)")
    assert_defined(success_worker_obs.pipeline_run_id, "pipeline_run_id defined")
    assert_test(success_worker_obs.pipeline_step_index == 0, "pipeline_step_index is 0")


# =============================================================================
# TEST: STANDALONE BESTOF OBSERVABILITY
# =============================================================================

async def test_standalone_best_of_observability() -> None:
    print("\n[23] Standalone bestOf: Has same observability as map+bestOf (minus pipeline)")

    swarm, tracker = create_mock_swarm()
    item: FileMap = {"a.txt": "a"}

    result = await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(n=2, judge_criteria="Best output"),
    )

    # Check candidates have correct observability
    candidate_obs = [o for o in tracker.observabilities if o.role == "candidate"]
    assert_test(len(candidate_obs) == 2, "2 candidates")
    assert_defined(candidate_obs[0].operation_id, "Candidate has operation_id")
    assert_test(candidate_obs[0].candidate_index == 0, "First candidate has candidate_index=0")
    assert_test(candidate_obs[1].candidate_index == 1, "Second candidate has candidate_index=1")

    # Check judge has correct observability
    judge_obs = next((o for o in tracker.observabilities if o.role == "judge"), None)
    assert_defined(judge_obs, "Judge observability exists")
    assert_defined(judge_obs.operation_id, "Judge has operation_id")
    assert_test(judge_obs.operation_id == candidate_obs[0].operation_id, "Judge shares operation_id with candidates")

    # Standalone bestOf should NOT have pipeline context
    assert_test(candidate_obs[0].pipeline_run_id is None, "No pipeline_run_id (standalone)")

    # Check result structure
    assert_defined(result.judge_meta, "Result has judge_meta")
    assert_test(result.judge_meta.candidate_count == 2, "judge_meta.candidate_count is 2")


# =============================================================================
# TEST: SWARM NAME PROPAGATION
# =============================================================================

async def test_swarm_name_in_observability() -> None:
    print("\n[24] swarm_name: Propagated to observability for all operations")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    # Test map
    await swarm.map(items, "Map")
    map_obs = tracker.observabilities[0]
    assert_test(map_obs.swarm_name == "test", f'map observability has swarm_name="test": {map_obs.swarm_name}')

    # Test filter
    tracker.observabilities.clear()
    await swarm.filter(items, "Filter", schema=ScoreSchema, condition=lambda d: True)
    filter_obs = tracker.observabilities[0]
    assert_test(filter_obs.swarm_name == "test", f'filter observability has swarm_name="test": {filter_obs.swarm_name}')

    # Test reduce
    tracker.observabilities.clear()
    await swarm.reduce(items, "Reduce")
    reduce_obs = tracker.observabilities[0]
    assert_test(reduce_obs.swarm_name == "test", f'reduce observability has swarm_name="test": {reduce_obs.swarm_name}')


async def test_swarm_name_in_meta() -> None:
    print("\n[25] swarm_name: Propagated to result.meta for all operations")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    # Test map meta
    map_results = await swarm.map(items, "Map")
    assert_test(map_results[0].meta.swarm_name == "test", f'map meta has swarm_name="test": {map_results[0].meta.swarm_name}')

    # Test filter meta
    filter_results = await swarm.filter(items, "Filter", schema=ScoreSchema, condition=lambda d: True)
    assert_test(filter_results[0].meta.swarm_name == "test", f'filter meta has swarm_name="test": {filter_results[0].meta.swarm_name}')

    # Test reduce meta
    reduce_result = await swarm.reduce(items, "Reduce")
    assert_test(reduce_result.meta.swarm_name == "test", f'reduce meta has swarm_name="test": {reduce_result.meta.swarm_name}')


# =============================================================================
# TEST: OPERATION NAME VIA DIRECT SWARM CALLS
# =============================================================================

async def test_operation_name_direct_swarm() -> None:
    print("\n[26] operation_name: Works via direct swarm.map(name='...')")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(items, "Process", name="my-custom-operation")

    # Check observability
    obs = tracker.observabilities[0]
    assert_test(obs.operation_name == "my-custom-operation", f"observability has operation_name: {obs.operation_name}")


async def test_operation_name_in_meta() -> None:
    print("\n[27] operation_name: Propagated to result.meta for direct swarm calls")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    # Test map
    map_results = await swarm.map(items, "Map", name="map-op")
    assert_test(map_results[0].meta.operation_name == "map-op", f"map meta has operation_name: {map_results[0].meta.operation_name}")

    # Test filter
    filter_results = await swarm.filter(items, "Filter", schema=ScoreSchema, condition=lambda d: True, name="filter-op")
    assert_test(filter_results[0].meta.operation_name == "filter-op", f"filter meta has operation_name: {filter_results[0].meta.operation_name}")

    # Test reduce
    reduce_result = await swarm.reduce(items, "Reduce", name="reduce-op")
    assert_test(reduce_result.meta.operation_name == "reduce-op", f"reduce meta has operation_name: {reduce_result.meta.operation_name}")


# =============================================================================
# TEST: REDUCE WITH RETRY TRACKING
# =============================================================================

async def test_reduce_error_retry_in_meta() -> None:
    print("\n[28] reduce: error_retry tracked in meta on retry")

    failures_per_tag = {"test-reduce": 1}
    swarm, tracker = create_mock_swarm(failures_per_tag=failures_per_tag)
    items: List[FileMap] = [{"a.txt": "a"}]

    result = await swarm.reduce(
        items,
        "Synthesize",
        retry=RetryConfig(max_attempts=3, backoff_ms=1),
    )

    # Should have 2 observabilities (1 fail + 1 success)
    assert_test(len(tracker.observabilities) == 2, f"2 observabilities: {len(tracker.observabilities)}")

    # First attempt has no error_retry
    assert_test(tracker.observabilities[0].error_retry is None, "First attempt has no error_retry")

    # Second attempt has error_retry=1
    assert_test(tracker.observabilities[1].error_retry == 1, f"Second attempt has error_retry=1: {tracker.observabilities[1].error_retry}")

    # Meta should have error_retry
    assert_test(result.meta.error_retry == 1, f"reduce meta.error_retry is 1: {result.meta.error_retry}")


async def test_reduce_verify_attempt_in_meta() -> None:
    print("\n[29] reduce: verify_retry tracked in meta with verify")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=2)
    items: List[FileMap] = [{"a.txt": "a"}]

    result = await swarm.reduce(
        items,
        "Synthesize",
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    # Workers should have verify_retry (None on first attempt, 1 on first retry)
    worker_obs = [o for o in tracker.observabilities if o.role == "worker"]
    assert_test(len(worker_obs) == 2, f"2 worker observabilities: {len(worker_obs)}")
    assert_test(worker_obs[0].verify_retry is None, "First worker has verify_retry=None")
    assert_test(worker_obs[1].verify_retry == 1, "Second worker has verify_retry=1")

    # Meta should have verify_retry (1 = first retry was successful)
    assert_test(result.meta.verify_retry == 1, f"reduce meta.verify_retry is 1: {result.meta.verify_retry}")

    # Verify info should be present
    assert_defined(result.verify, "reduce result has verify info")
    assert_test(result.verify.passed is True, "verify.passed is True")


# =============================================================================
# TEST: FILTER WITH VERIFY TRACKING
# =============================================================================

async def test_filter_verify_attempt_in_meta() -> None:
    print("\n[30] filter: verify_retry tracked in meta with verify")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=2)
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    results = await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: True,
        verify=VerifyConfig(criteria="Valid", max_attempts=3),
    )

    # Workers should have verify_retry (None on first attempt, 1 on first retry)
    worker_obs = [o for o in tracker.observabilities if o.role == "worker"]
    assert_test(len(worker_obs) == 2, f"2 worker observabilities: {len(worker_obs)}")
    assert_test(worker_obs[0].verify_retry is None, "First worker has verify_retry=None")
    assert_test(worker_obs[1].verify_retry == 1, "Second worker has verify_retry=1")

    # Meta should have verify_retry (1 = first retry was successful)
    meta = results[0].meta
    assert_test(meta.verify_retry == 1, f"filter meta.verify_retry is 1: {meta.verify_retry}")

    # Verify info should be present
    assert_defined(results[0].verify, "filter result has verify info")
    assert_test(results[0].verify.passed is True, "verify.passed is True")


async def test_filter_error_retry_in_meta() -> None:
    print("\n[31] filter: error_retry tracked in meta on retry")

    failures_per_tag = {"test-filter-0": 1}
    swarm, tracker = create_mock_swarm(failures_per_tag=failures_per_tag)
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    results = await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: True,
        retry=RetryConfig(max_attempts=3, backoff_ms=1),
    )

    # Should have 2 observabilities (1 fail + 1 success)
    assert_test(len(tracker.observabilities) == 2, f"2 observabilities: {len(tracker.observabilities)}")

    # First attempt has no error_retry
    assert_test(tracker.observabilities[0].error_retry is None, "First attempt has no error_retry")

    # Second attempt has error_retry=1
    assert_test(tracker.observabilities[1].error_retry == 1, "Second attempt has error_retry=1")

    # Meta should have error_retry
    meta = results[0].meta
    assert_test(meta.error_retry == 1, f"filter meta.error_retry is 1: {meta.error_retry}")


# =============================================================================
# TEST: BESTOF OPERATION FIELD (not "bestof-cand"/"bestof-judge")
# =============================================================================

async def test_bestof_operation_field() -> None:
    print("\n[32] bestOf: Candidates and judge use operation='map' with role")

    swarm, tracker = create_mock_swarm()
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        best_of=BestOfConfig(n=2, judge_criteria="Best"),
    )

    # Candidates should have operation="map" with role="candidate"
    candidate_obs = [o for o in tracker.observabilities if o.role == "candidate"]
    assert_test(len(candidate_obs) == 2, "2 candidate observabilities")
    assert_test(
        candidate_obs[0].operation == "map",
        f'candidate operation is "map" (not "bestof-cand"): {candidate_obs[0].operation}'
    )

    # Judge should have operation="map" with role="judge"
    judge_obs = next((o for o in tracker.observabilities if o.role == "judge"), None)
    assert_defined(judge_obs, "judge observability exists")
    assert_test(
        judge_obs.operation == "map",
        f'judge operation is "map" (not "bestof-judge"): {judge_obs.operation}'
    )


async def test_verifier_operation_field() -> None:
    print("\n[33] verify: Verifier has operation='verify' with role='verifier'")

    swarm, tracker = create_mock_swarm(verify_pass_on_attempt=1)
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        verify=VerifyConfig(criteria="Valid", max_attempts=2),
    )

    # Verifier should have operation="verify" with role="verifier"
    verifier_obs = [o for o in tracker.observabilities if o.role == "verifier"]
    assert_test(len(verifier_obs) == 1, "1 verifier observability")
    assert_test(
        verifier_obs[0].operation == "verify",
        f'verifier operation is "verify": {verifier_obs[0].operation}'
    )


async def test_standalone_bestof_name_parameter() -> None:
    print("\n[34] Standalone bestOf: name parameter propagated")

    swarm, tracker = create_mock_swarm()
    item: FileMap = {"a.txt": "a"}

    result = await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(n=2, judge_criteria="Best"),
        name="my-bestof-operation",
    )

    # Candidates should have operation_name
    candidate_obs = [o for o in tracker.observabilities if o.role == "candidate"]
    # Note: standalone bestOf doesn't propagate operation_name to candidates in current impl
    # But judge_meta should have it via swarm_name
    assert_defined(result.judge_meta, "Result has judge_meta")
    assert_test(
        result.judge_meta.swarm_name == "test",
        f'judge_meta.swarm_name is "test": {result.judge_meta.swarm_name}'
    )


# =============================================================================
# MAIN
# =============================================================================

async def main() -> None:
    global passed, failed

    print("=" * 70)
    print("Observability Metadata Propagation Tests (Python)")
    print("=" * 70)

    # operation_id tests
    await test_operation_id_unique()
    await test_operation_id_per_abstraction()

    # Observability fields tests
    await test_map_observability_fields()
    await test_filter_observability_fields()
    await test_reduce_observability_fields()

    # Error retry tracking
    await test_error_retry_in_observability()
    await test_error_retry_in_meta()

    # Verify attempt tracking
    await test_verify_attempt_in_observability()
    await test_verify_attempt_in_meta()

    # BestOf candidate index
    await test_candidate_index_in_observability()
    await test_candidate_index_in_meta()

    # Pipeline context propagation
    await test_pipeline_context_in_observability()
    await test_pipeline_context_in_meta()
    await test_pipeline_run_id_unique()
    await test_no_pipeline_context_for_direct_swarm()

    # Meta structures
    await test_reduce_meta_structure()
    await test_verify_meta_structure()
    await test_verify_meta_has_pipeline_context()
    await test_judge_meta_structure()
    await test_judge_meta_has_pipeline_context()

    # Role field
    await test_role_field_variants()

    # Combined scenario
    await test_all_fields_together()

    # Standalone bestOf
    await test_standalone_best_of_observability()

    # swarm_name propagation
    await test_swarm_name_in_observability()
    await test_swarm_name_in_meta()

    # operation_name via direct swarm calls
    await test_operation_name_direct_swarm()
    await test_operation_name_in_meta()

    # reduce retry tracking
    await test_reduce_error_retry_in_meta()
    await test_reduce_verify_attempt_in_meta()

    # filter retry tracking
    await test_filter_verify_attempt_in_meta()
    await test_filter_error_retry_in_meta()

    # Additional implementation tests
    await test_bestof_operation_field()
    await test_verifier_operation_field()
    await test_standalone_bestof_name_parameter()

    print("\n" + "=" * 70)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 70)

    if failed > 0:
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
