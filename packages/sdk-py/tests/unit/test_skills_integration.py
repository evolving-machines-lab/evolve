#!/usr/bin/env python3
"""
Unit Test: Skills Integration

Tests skills support across Evolve, Swarm, and Pipeline:
- Evolve skills parameter in __init__
- Swarm passes skills through _execute() observability
- Skills resolution: swarm-level default, per-operation override
- BestOf: candidate_skills, judge_skills resolution via config
- Verify: verifier_skills resolution via config
- Pipeline: skills passed from step config through to Swarm

Uses mocked _execute() to avoid real sandbox/agent calls.

Usage:
  pytest tests/unit/test_skills_integration.py -v
  python tests/unit/test_skills_integration.py
"""

import asyncio
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))

from evolve import Swarm, SwarmConfig, BestOfConfig, VerifyConfig
from evolve import Evolve, E2BProvider
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


def assert_list_equals(actual: Optional[List], expected: Optional[List], message: str) -> None:
    global passed, failed
    if actual == expected:
        passed += 1
        print(f"  ✓ {message}")
    else:
        failed += 1
        print(f"  ✗ {message} (got {actual}, expected {expected})")


async def sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


# =============================================================================
# MOCK INFRASTRUCTURE
# =============================================================================

@dataclass
class ExecuteCall:
    tag_prefix: str
    skills: Optional[List[str]] = None
    role: Optional[str] = None


@dataclass
class MockTracker:
    calls: List[ExecuteCall] = field(default_factory=list)


def create_mock_swarm(
    swarm_skills: Optional[List[str]] = None,
    verify_pass_on_attempt: int = 1,
) -> tuple:
    """Create a Swarm with mocked _execute for skills testing."""
    tracker = MockTracker()
    verify_attempts: Dict[str, int] = {}

    config = SwarmConfig(
        tag="test",
        concurrency=4,
        skills=swarm_skills,
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
        skills: Optional[List[str]] = None,
        tag_prefix: str = "",
        timeout: int = 60000,
        observability: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        # Capture skills from parameter
        role = observability.get('role') if observability else None

        call = ExecuteCall(
            tag_prefix=tag_prefix,
            skills=skills,
            role=role,
        )
        tracker.calls.append(call)

        await sleep_ms(5)

        is_verify = "-verifier" in tag_prefix

        if is_verify:
            # Track verify attempts
            item_key = tag_prefix.split("-verifier")[0]
            current_attempt = verify_attempts.get(item_key, 0) + 1
            verify_attempts[item_key] = current_attempt

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
# TEST: EVOLVE SKILLS PARAMETER
# =============================================================================

async def test_evolve_skills_parameter() -> None:
    print("\n[1] Evolve: skills parameter stored correctly")

    kit = Evolve(skills=["pdf", "dev-browser"])

    assert_list_equals(kit.skills, ["pdf", "dev-browser"], "skills stored on Evolve")


async def test_evolve_skills_none_by_default() -> None:
    print("\n[2] Evolve: skills is None by default")

    kit = Evolve()

    assert_test(kit.skills is None, "skills is None when not provided")


# =============================================================================
# TEST: SWARM DEFAULT SKILLS
# =============================================================================

async def test_swarm_default_skills() -> None:
    print("\n[3] Swarm: Default skills passed to _execute()")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf", "docx"])
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(items, "Process")

    assert_test(len(tracker.calls) == 1, "1 execute call")
    assert_list_equals(tracker.calls[0].skills, ["pdf", "docx"], "skills passed to execute")


async def test_swarm_no_default_skills() -> None:
    print("\n[4] Swarm: No default skills = None in _execute()")

    swarm, tracker = create_mock_swarm()  # No skills
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(items, "Process")

    assert_test(len(tracker.calls) == 1, "1 execute call")
    assert_test(tracker.calls[0].skills is None, "skills is None when not configured")


# =============================================================================
# TEST: PER-OPERATION OVERRIDE
# =============================================================================

async def test_map_skills_override() -> None:
    print("\n[5] map(): Per-operation skills override swarm default")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])  # Default: pdf
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(items, "Process", skills=["xlsx", "pptx"])  # Override

    assert_list_equals(tracker.calls[0].skills, ["xlsx", "pptx"], "operation skills override default")


async def test_filter_skills_override() -> None:
    print("\n[6] filter(): Per-operation skills override swarm default")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: True,
        skills=["dev-browser"],
    )

    assert_list_equals(tracker.calls[0].skills, ["dev-browser"], "filter skills override default")


async def test_reduce_skills_override() -> None:
    print("\n[7] reduce(): Per-operation skills override swarm default")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf", "docx"])
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    await swarm.reduce(items, "Synthesize", skills=["xlsx"])

    assert_list_equals(tracker.calls[0].skills, ["xlsx"], "reduce skills override default")


# =============================================================================
# TEST: BESTOF SKILLS RESOLUTION
# =============================================================================

async def test_bestof_candidate_skills() -> None:
    print("\n[8] bestOf(): Candidates use config.skills (overrides swarm default)")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])  # Swarm default
    item: FileMap = {"a.txt": "a"}

    await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(
            n=2,
            judge_criteria="Best",
            skills=["xlsx"],  # Candidate override
        ),
    )

    candidate_calls = [c for c in tracker.calls if c.role == "candidate"]
    assert_test(len(candidate_calls) == 2, "2 candidate calls")
    assert_list_equals(candidate_calls[0].skills, ["xlsx"], "candidate 0 uses config.skills")
    assert_list_equals(candidate_calls[1].skills, ["xlsx"], "candidate 1 uses config.skills")


async def test_bestof_candidate_skills_fallback() -> None:
    print("\n[9] bestOf(): Candidates fall back to swarm default when config.skills is None")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf", "docx"])
    item: FileMap = {"a.txt": "a"}

    await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(
            n=2,
            judge_criteria="Best",
            # No skills override - should use swarm default
        ),
    )

    candidate_calls = [c for c in tracker.calls if c.role == "candidate"]
    assert_list_equals(candidate_calls[0].skills, ["pdf", "docx"], "candidates use swarm default")


async def test_bestof_judge_skills() -> None:
    print("\n[10] bestOf(): Judge uses config.judge_skills")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    item: FileMap = {"a.txt": "a"}

    await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(
            n=2,
            judge_criteria="Best",
            skills=["xlsx"],
            judge_skills=["dev-browser"],  # Judge-specific override
        ),
    )

    judge_calls = [c for c in tracker.calls if c.role == "judge"]
    assert_test(len(judge_calls) == 1, "1 judge call")
    assert_list_equals(judge_calls[0].skills, ["dev-browser"], "judge uses judge_skills")


async def test_bestof_judge_skills_fallback() -> None:
    print("\n[11] bestOf(): Judge falls back to config.skills, then swarm default")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    item: FileMap = {"a.txt": "a"}

    # Test 1: Judge falls back to config.skills
    await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(
            n=2,
            judge_criteria="Best",
            skills=["xlsx"],  # No judge_skills - should use this
        ),
    )

    judge_calls = [c for c in tracker.calls if c.role == "judge"]
    assert_list_equals(judge_calls[0].skills, ["xlsx"], "judge falls back to config.skills")

    # Test 2: Judge falls back to swarm default
    tracker.calls.clear()
    await swarm.best_of(
        item,
        "Process",
        config=BestOfConfig(
            n=2,
            judge_criteria="Best",
            # No skills or judge_skills - should use swarm default
        ),
    )

    judge_calls = [c for c in tracker.calls if c.role == "judge"]
    assert_list_equals(judge_calls[0].skills, ["pdf"], "judge falls back to swarm default")


# =============================================================================
# TEST: MAP WITH BESTOF SKILLS
# =============================================================================

async def test_map_with_bestof_skills() -> None:
    print("\n[12] map(best_of): Skills resolution in map+bestOf combo")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        skills=["docx"],  # Operation-level override
        best_of=BestOfConfig(
            n=2,
            judge_criteria="Best",
            skills=["xlsx"],  # BestOf candidate override
            judge_skills=["pptx"],  # BestOf judge override
        ),
    )

    candidate_calls = [c for c in tracker.calls if c.role == "candidate"]
    judge_calls = [c for c in tracker.calls if c.role == "judge"]

    assert_list_equals(candidate_calls[0].skills, ["xlsx"], "candidates use bestOf.skills")
    assert_list_equals(judge_calls[0].skills, ["pptx"], "judge uses bestOf.judge_skills")


async def test_map_with_bestof_skills_fallback() -> None:
    print("\n[13] map(best_of): Fallback chain: bestOf.skills → params.skills → swarm default")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    # Test: bestOf.skills undefined → use params.skills
    await swarm.map(
        items,
        "Process",
        skills=["docx"],  # params.skills
        best_of=BestOfConfig(
            n=2,
            judge_criteria="Best",
            # No skills - should fall back to params.skills
        ),
    )

    candidate_calls = [c for c in tracker.calls if c.role == "candidate"]
    assert_list_equals(candidate_calls[0].skills, ["docx"], "candidates fall back to params.skills")

    # Test: Both undefined → use swarm default
    tracker.calls.clear()
    await swarm.map(
        items,
        "Process",
        # No skills at any level - should use swarm default
        best_of=BestOfConfig(
            n=2,
            judge_criteria="Best",
        ),
    )

    candidate_calls = [c for c in tracker.calls if c.role == "candidate"]
    assert_list_equals(candidate_calls[0].skills, ["pdf"], "candidates fall back to swarm default")


# =============================================================================
# TEST: VERIFY SKILLS RESOLUTION
# =============================================================================

async def test_verify_verifier_skills() -> None:
    print("\n[14] verify: verifier_skills override for verifier")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        skills=["docx"],
        verify=VerifyConfig(
            criteria="Valid",
            max_attempts=1,
            verifier_skills=["dev-browser"],  # Verifier-specific
        ),
    )

    worker_calls = [c for c in tracker.calls if c.role == "worker"]
    verifier_calls = [c for c in tracker.calls if c.role == "verifier"]

    assert_list_equals(worker_calls[0].skills, ["docx"], "worker uses params.skills")
    assert_list_equals(verifier_calls[0].skills, ["dev-browser"], "verifier uses verifier_skills")


async def test_verify_verifier_skills_fallback() -> None:
    print("\n[15] verify: verifier_skills falls back to params.skills")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(
        items,
        "Process",
        skills=["docx"],
        verify=VerifyConfig(
            criteria="Valid",
            max_attempts=1,
            # No verifier_skills - should use params.skills
        ),
    )

    verifier_calls = [c for c in tracker.calls if c.role == "verifier"]
    assert_list_equals(verifier_calls[0].skills, ["docx"], "verifier falls back to params.skills")


# =============================================================================
# TEST: PIPELINE SKILLS
# =============================================================================

async def test_pipeline_step_skills() -> None:
    print("\n[16] Pipeline: Step skills passed to Swarm operations")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    pipeline = Pipeline(swarm).map(MapConfig(prompt="Step 1", skills=["xlsx"]))

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    assert_list_equals(tracker.calls[0].skills, ["xlsx"], "pipeline step skills passed to swarm")


async def test_pipeline_step_skills_fallback() -> None:
    print("\n[17] Pipeline: Step without skills uses swarm default")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf", "docx"])
    pipeline = Pipeline(swarm).map(MapConfig(prompt="Step 1"))  # No skills

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    assert_list_equals(tracker.calls[0].skills, ["pdf", "docx"], "pipeline step falls back to swarm default")


async def test_pipeline_multi_step_different_skills() -> None:
    print("\n[18] Pipeline: Each step can have different skills")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    pipeline = (
        Pipeline(swarm)
        .map(MapConfig(prompt="Step 1", skills=["xlsx"]))
        .filter(FilterConfig(
            prompt="Step 2",
            schema=ScoreSchema,
            condition=lambda d: True,
            skills=["docx"],
        ))
        .reduce(ReduceConfig(prompt="Step 3", skills=["pptx"]))
    )

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    # Find calls by tag pattern
    map_calls = [c for c in tracker.calls if "map" in c.tag_prefix]
    filter_calls = [c for c in tracker.calls if "filter" in c.tag_prefix]
    reduce_calls = [c for c in tracker.calls if "reduce" in c.tag_prefix]

    assert_list_equals(map_calls[0].skills, ["xlsx"], "map step has xlsx")
    assert_list_equals(filter_calls[0].skills, ["docx"], "filter step has docx")
    assert_list_equals(reduce_calls[0].skills, ["pptx"], "reduce step has pptx")


async def test_pipeline_with_bestof_skills() -> None:
    print("\n[19] Pipeline: Map step with bestOf skills")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    pipeline = Pipeline(swarm).map(MapConfig(
        prompt="Process",
        skills=["docx"],
        best_of=BestOfConfig(
            n=2,
            judge_criteria="Best",
            skills=["xlsx"],
            judge_skills=["pptx"],
        ),
    ))

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    candidate_calls = [c for c in tracker.calls if c.role == "candidate"]
    judge_calls = [c for c in tracker.calls if c.role == "judge"]

    assert_list_equals(candidate_calls[0].skills, ["xlsx"], "pipeline bestOf candidates use bestOf.skills")
    assert_list_equals(judge_calls[0].skills, ["pptx"], "pipeline bestOf judge uses judge_skills")


async def test_pipeline_with_verify_skills() -> None:
    print("\n[20] Pipeline: Map step with verify skills")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    pipeline = Pipeline(swarm).map(MapConfig(
        prompt="Process",
        skills=["docx"],
        verify=VerifyConfig(
            criteria="Valid",
            max_attempts=1,
            verifier_skills=["dev-browser"],
        ),
    ))

    items: List[FileMap] = [{"a.txt": "a"}]
    await pipeline.run(items)

    worker_calls = [c for c in tracker.calls if c.role == "worker"]
    verifier_calls = [c for c in tracker.calls if c.role == "verifier"]

    assert_list_equals(worker_calls[0].skills, ["docx"], "pipeline verify worker uses step skills")
    assert_list_equals(verifier_calls[0].skills, ["dev-browser"], "pipeline verify verifier uses verifier_skills")


# =============================================================================
# TEST: EDGE CASES
# =============================================================================

async def test_empty_skills_array() -> None:
    print("\n[21] Empty skills array: Passed through (not treated as None)")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    await swarm.map(items, "Process", skills=[])  # Empty array override

    # Empty array should override swarm default (not fall back)
    assert_list_equals(tracker.calls[0].skills, [], "empty array passed through (overrides default)")


async def test_all_operations_with_skills() -> None:
    print("\n[22] All operations: Skills work consistently across map/filter/reduce")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    # Run all operations with different skills
    await swarm.map(items, "Map", skills=["xlsx"])
    await swarm.filter(items, "Filter", schema=ScoreSchema, condition=lambda d: True, skills=["docx"])
    await swarm.reduce(items, "Reduce", skills=["pptx"])

    assert_list_equals(tracker.calls[0].skills, ["xlsx"], "map uses xlsx")
    assert_list_equals(tracker.calls[1].skills, ["docx"], "filter uses docx")
    assert_list_equals(tracker.calls[2].skills, ["pptx"], "reduce uses pptx")


# =============================================================================
# TEST: FILTER WITH VERIFY SKILLS
# =============================================================================

async def test_filter_with_verify_skills() -> None:
    print("\n[23] filter(verify): verifier_skills work in filter")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}]

    from pydantic import BaseModel
    class ScoreSchema(BaseModel):
        score: int

    await swarm.filter(
        items,
        "Evaluate",
        schema=ScoreSchema,
        condition=lambda d: True,
        skills=["docx"],
        verify=VerifyConfig(
            criteria="Valid",
            max_attempts=1,
            verifier_skills=["xlsx"],
        ),
    )

    worker_calls = [c for c in tracker.calls if c.role == "worker"]
    verifier_calls = [c for c in tracker.calls if c.role == "verifier"]

    assert_list_equals(worker_calls[0].skills, ["docx"], "filter worker uses skills")
    assert_list_equals(verifier_calls[0].skills, ["xlsx"], "filter verifier uses verifier_skills")


# =============================================================================
# TEST: REDUCE WITH VERIFY SKILLS
# =============================================================================

async def test_reduce_with_verify_skills() -> None:
    print("\n[24] reduce(verify): verifier_skills work in reduce")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [{"a.txt": "a"}, {"b.txt": "b"}]

    await swarm.reduce(
        items,
        "Synthesize",
        skills=["docx"],
        verify=VerifyConfig(
            criteria="Valid",
            max_attempts=1,
            verifier_skills=["xlsx"],
        ),
    )

    worker_calls = [c for c in tracker.calls if c.role == "worker"]
    verifier_calls = [c for c in tracker.calls if c.role == "verifier"]

    assert_list_equals(worker_calls[0].skills, ["docx"], "reduce worker uses skills")
    assert_list_equals(verifier_calls[0].skills, ["xlsx"], "reduce verifier uses verifier_skills")


# =============================================================================
# TEST: MULTIPLE ITEMS
# =============================================================================

async def test_multiple_items_same_skills() -> None:
    print("\n[25] Multiple items: All items use same skills")

    swarm, tracker = create_mock_swarm(swarm_skills=["pdf"])
    items: List[FileMap] = [
        {"a.txt": "a"},
        {"b.txt": "b"},
        {"c.txt": "c"},
    ]

    await swarm.map(items, "Process", skills=["xlsx", "docx"])

    assert_test(len(tracker.calls) == 3, "3 execute calls")
    for i, call in enumerate(tracker.calls):
        assert_list_equals(call.skills, ["xlsx", "docx"], f"item {i} has correct skills")


# =============================================================================
# MAIN
# =============================================================================

async def main() -> None:
    global passed, failed

    print("=" * 70)
    print("Skills Integration Tests (Python)")
    print("=" * 70)

    # Evolve tests
    await test_evolve_skills_parameter()
    await test_evolve_skills_none_by_default()

    # Swarm default skills
    await test_swarm_default_skills()
    await test_swarm_no_default_skills()

    # Per-operation override
    await test_map_skills_override()
    await test_filter_skills_override()
    await test_reduce_skills_override()

    # BestOf skills resolution
    await test_bestof_candidate_skills()
    await test_bestof_candidate_skills_fallback()
    await test_bestof_judge_skills()
    await test_bestof_judge_skills_fallback()

    # Map with bestOf
    await test_map_with_bestof_skills()
    await test_map_with_bestof_skills_fallback()

    # Verify skills
    await test_verify_verifier_skills()
    await test_verify_verifier_skills_fallback()

    # Pipeline
    await test_pipeline_step_skills()
    await test_pipeline_step_skills_fallback()
    await test_pipeline_multi_step_different_skills()
    await test_pipeline_with_bestof_skills()
    await test_pipeline_with_verify_skills()

    # Edge cases
    await test_empty_skills_array()
    await test_all_operations_with_skills()

    # Additional tests
    await test_filter_with_verify_skills()
    await test_reduce_with_verify_skills()
    await test_multiple_items_same_skills()

    print("\n" + "=" * 70)
    print(f"Results: {passed} passed, {failed} failed")
    print("=" * 70)

    if failed > 0:
        exit(1)


if __name__ == "__main__":
    asyncio.run(main())
