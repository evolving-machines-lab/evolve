#!/usr/bin/env python3
"""Integration Test 23: Storage Edge Cases -- Multi-Session Cross-Tag (BYOK + Gateway)

End-to-end test for cross-session checkpoint scenarios.
Mirrors TypeScript integration test 23-storage-edge-cases.ts.

Tests:
  1. Multi-session limit+tag -- two sessions create checkpoints with different tags,
     then list_checkpoints(limit, tag) returns exactly the right count from the right tag
  2. from_checkpoint='latest' global scope -- restores from globally newest checkpoint
     regardless of which session created it
  3. Cross-session list_checkpoints ordering -- newest-first across mixed tags
  4. Limit without tag -- limits correctly across mixed tags

Requires:
  EVOLVE_API_KEY -- LLM gateway (both modes) + dashboard auth (gateway mode)
  E2B_API_KEY -- sandbox provider (or DAYTONA_API_KEY / MODAL_TOKEN_ID+SECRET)
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY -- S3 credentials (BYOK only)
"""

import asyncio
import os
from datetime import datetime

import pytest

from evolve import Evolve, CheckpointInfo, StorageConfig, list_checkpoints
from tests.utils.agent_config import get_agent_config, validate_agent_config
from tests.utils.test_helpers import (
    create_sandbox_provider,
    log_section,
    log_result,
    log_info,
    assert_true,
)

# =============================================================================
# CONFIG
# =============================================================================

PROVIDER_NAME = os.getenv('TEST_SANDBOX_PROVIDER', 'e2b')
STORAGE_MODE = os.getenv('TEST_STORAGE_MODE', 'byok')
IS_GATEWAY = STORAGE_MODE == 'gateway'
STORAGE_URL = f's3://swarmkit-test-checkpoints-905418019965/py-integration-test-edge-{PROVIDER_NAME}/'
STORAGE_REGION = 'us-west-2'
TIMEOUT = 180000  # 3 min per run

agent_config = get_agent_config()
validate_agent_config(agent_config)


def get_storage_config() -> StorageConfig:
    if IS_GATEWAY:
        return StorageConfig()
    return StorageConfig(url=STORAGE_URL, region=STORAGE_REGION)


# =============================================================================
# TEST
# =============================================================================


@pytest.mark.asyncio
async def test_storage_edge_cases_cross_session():
    """Multi-session cross-tag: limit+tag, from='latest' global, ordering, limit without tag."""
    log_section(f'Storage edge cases -- multi-session cross-tag ({STORAGE_MODE} mode)')

    provider = create_sandbox_provider(PROVIDER_NAME)
    storage_config = get_storage_config()

    log_info(f'Using provider: {PROVIDER_NAME}, storage: {STORAGE_MODE}')

    session_a_checkpoints: list[CheckpointInfo] = []
    session_b_checkpoints: list[CheckpointInfo] = []
    tag_a = ''
    tag_b = ''

    # =================================================================
    # Phase 1: Session A -- create 2 checkpoints
    # =================================================================
    log_info('-- Phase 1: Session A -- create 2 checkpoints')

    evolve_a = Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    )

    try:
        # Run 1A
        run_1a = await evolve_a.run(
            prompt="Create a file called session-a.txt with content 'Session A checkpoint 1'",
            timeout_ms=TIMEOUT,
            checkpoint_comment='session-A run 1',
        )

        assert_true(run_1a.exit_code == 0, 'run_1a exits 0')
        assert_true(run_1a.checkpoint is not None, 'run_1a.checkpoint is defined')
        session_a_checkpoints.append(run_1a.checkpoint)
        tag_a = run_1a.checkpoint.tag
        log_info(f'Session A tag: {tag_a}')

        # Run 2A (same session, builds lineage)
        run_2a = await evolve_a.run(
            prompt="Append ' - updated' to session-a.txt",
            timeout_ms=TIMEOUT,
            checkpoint_comment='session-A run 2',
        )

        assert_true(run_2a.exit_code == 0, 'run_2a exits 0')
        assert_true(run_2a.checkpoint is not None, 'run_2a.checkpoint is defined')
        session_a_checkpoints.append(run_2a.checkpoint)

        # Verify lineage within session A
        assert_true(
            run_2a.checkpoint.parent_id == run_1a.checkpoint.id,
            'session A: run_2a parent_id = run_1a checkpoint ID',
        )

    finally:
        try:
            await evolve_a.kill()
        except Exception:
            pass

    log_result(True, f'Phase 1 complete (session A: {len(session_a_checkpoints)} checkpoints)')

    # =================================================================
    # Phase 2: Session B -- create 2 checkpoints (different tag)
    # =================================================================
    log_info('-- Phase 2: Session B -- create 2 checkpoints (different tag)')

    evolve_b = Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    )

    try:
        # Run 1B
        run_1b = await evolve_b.run(
            prompt="Create a file called session-b.txt with content 'Session B checkpoint 1'",
            timeout_ms=TIMEOUT,
            checkpoint_comment='session-B run 1',
        )

        assert_true(run_1b.exit_code == 0, 'run_1b exits 0')
        assert_true(run_1b.checkpoint is not None, 'run_1b.checkpoint is defined')
        session_b_checkpoints.append(run_1b.checkpoint)
        tag_b = run_1b.checkpoint.tag
        log_info(f'Session B tag: {tag_b}')

        # Verify tags are different (separate sessions get unique tags)
        assert_true(tag_a != tag_b, 'Session A and B have different tags')

        # Run 2B
        run_2b = await evolve_b.run(
            prompt="Append ' - updated' to session-b.txt",
            timeout_ms=TIMEOUT,
            checkpoint_comment='session-B run 2',
        )

        assert_true(run_2b.exit_code == 0, 'run_2b exits 0')
        assert_true(run_2b.checkpoint is not None, 'run_2b.checkpoint is defined')
        session_b_checkpoints.append(run_2b.checkpoint)

    finally:
        try:
            await evolve_b.kill()
        except Exception:
            pass

    log_result(True, f'Phase 2 complete (session B: {len(session_b_checkpoints)} checkpoints)')

    # Brief delay for S3 read-after-write consistency on listing
    log_info('Waiting 3s for S3 consistency...')
    await asyncio.sleep(3)

    # =================================================================
    # Phase 3: list_checkpoints(limit, tag) -- cross-tag filtering
    # =================================================================
    log_info('-- Phase 3: list_checkpoints(limit, tag) -- cross-tag filtering')

    # 3a: tag=A, limit=1 -- should get only session A's newest
    list_a1 = await list_checkpoints(storage=storage_config, limit=1, tag=tag_a)
    assert_true(len(list_a1) == 1, 'limit=1, tag=A returns exactly 1')
    assert_true(
        list_a1[0].id == session_a_checkpoints[1].id,
        "tag=A limit=1 returns A's newest checkpoint",
    )
    assert_true(list_a1[0].tag == tag_a, 'Result tag matches tag_a')

    # 3b: tag=A, limit=10 -- should get all 2 from session A
    list_a2 = await list_checkpoints(storage=storage_config, limit=10, tag=tag_a)
    assert_true(len(list_a2) == 2, 'limit=10, tag=A returns all 2 session A checkpoints')
    assert_true(
        all(cp.tag == tag_a for cp in list_a2),
        'All results have tag=A (no session B leakage)',
    )
    assert_true(list_a2[0].id == session_a_checkpoints[1].id, 'Newest A first')
    assert_true(list_a2[1].id == session_a_checkpoints[0].id, 'Oldest A second')

    # 3c: tag=B, limit=1 -- should get only session B's newest
    list_b1 = await list_checkpoints(storage=storage_config, limit=1, tag=tag_b)
    assert_true(len(list_b1) == 1, 'limit=1, tag=B returns exactly 1')
    assert_true(
        list_b1[0].id == session_b_checkpoints[1].id,
        "tag=B limit=1 returns B's newest checkpoint",
    )
    assert_true(list_b1[0].tag == tag_b, 'Result tag matches tag_b')

    log_result(True, 'Phase 3 complete')

    # =================================================================
    # Phase 4: Cross-session ordering (no tag filter)
    # =================================================================
    log_info('-- Phase 4: Cross-session ordering (no tag filter)')

    all_checkpoints = await list_checkpoints(storage=storage_config)

    # Should have at least 4 checkpoints total
    assert_true(
        len(all_checkpoints) >= 4,
        f'list_checkpoints() returned >= 4 (got {len(all_checkpoints)})',
    )

    # Verify newest-first ordering: timestamps should be descending
    for i in range(1, len(all_checkpoints)):
        prev_ts = datetime.fromisoformat(all_checkpoints[i - 1].timestamp.replace('Z', '+00:00'))
        curr_ts = datetime.fromisoformat(all_checkpoints[i].timestamp.replace('Z', '+00:00'))
        assert_true(
            prev_ts >= curr_ts,
            f'Checkpoint {i - 1} ({all_checkpoints[i - 1].timestamp}) >= checkpoint {i} ({all_checkpoints[i].timestamp})',
        )

    log_info('All checkpoints sorted newest-first')

    # Session B was created after session A, so B's checkpoints should appear first
    first_cp_tag = all_checkpoints[0].tag
    log_info(f'First checkpoint tag: {first_cp_tag} (expected {tag_b} if B ran after A)')

    log_result(True, 'Phase 4 complete')

    # =================================================================
    # Phase 5: Limit without tag -- mixed tags
    # =================================================================
    log_info('-- Phase 5: Limit without tag -- mixed tags')

    limited_2 = await list_checkpoints(storage=storage_config, limit=2)
    assert_true(len(limited_2) == 2, 'limit=2 returns exactly 2 entries')

    # Should be the 2 newest regardless of tag
    assert_true(limited_2[0].id == all_checkpoints[0].id, 'limit=2 first matches overall newest')
    assert_true(limited_2[1].id == all_checkpoints[1].id, 'limit=2 second matches overall second')

    limited_3 = await list_checkpoints(storage=storage_config, limit=3)
    assert_true(len(limited_3) == 3, 'limit=3 returns exactly 3 entries')

    log_result(True, 'Phase 5 complete')

    # =================================================================
    # Phase 6: from_checkpoint='latest' global scope
    # =================================================================
    log_info("-- Phase 6: from_checkpoint='latest' -- global scope")

    # The globally newest checkpoint should be session B's last checkpoint
    global_newest = all_checkpoints[0]
    log_info(f'Global newest: id={global_newest.id}, tag={global_newest.tag}')

    async with Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    ) as evolve_c:
        run_c = await evolve_c.run(
            prompt='List all .txt files in the workspace and tell me their names.',
            from_checkpoint='latest',
            timeout_ms=TIMEOUT,
        )

        assert_true(run_c.exit_code == 0, 'run_c exits 0')
        assert_true(run_c.checkpoint is not None, 'run_c.checkpoint is defined')

        # The parent should be the global newest (the checkpoint we restored from)
        assert_true(
            run_c.checkpoint.parent_id == global_newest.id,
            f'run_c parent_id = global newest ({global_newest.id})',
        )

    log_result(True, 'Phase 6 complete')
    log_result(True, 'All storage edge case tests passed')
