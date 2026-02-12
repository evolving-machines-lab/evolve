#!/usr/bin/env python3
"""Integration Test 22: Storage DX v3.3 Features (BYOK + Gateway)

End-to-end test for all v3.3 checkpoint DX improvements.
Mirrors TypeScript integration test 22-storage-dx.ts.

Tests:
  1. list_checkpoints() -- returns checkpoints sorted by newest first
  2. from_checkpoint='latest' -- resolves and restores the most recent checkpoint
  3. checkpoint(comment=...) -- explicit checkpoint with label
  4. checkpoint_comment -- passthrough via run()
  5. parent_id lineage -- chained across runs
  6. Evolve.list_checkpoints() -- instance method
  7. Limit parameter -- restricts number of results

Requires:
  EVOLVE_API_KEY -- LLM gateway
  E2B_API_KEY -- sandbox provider
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY -- S3 credentials (BYOK only)
"""

import os
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
STORAGE_URL = f's3://swarmkit-test-checkpoints-905418019965/py-integration-test-dx-{PROVIDER_NAME}/'
STORAGE_REGION = 'us-west-2'
TIMEOUT = 180000

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
async def test_storage_dx_features():
    """Full DX v3.3 feature test: comment, lineage, list, limit, latest."""
    log_section(f'Storage DX v3.3 features ({STORAGE_MODE} mode)')

    provider = create_sandbox_provider(PROVIDER_NAME)
    storage_config = get_storage_config()

    log_info(f'Using provider: {PROVIDER_NAME}, storage: {STORAGE_MODE}')

    # =================================================================
    # Phase 1: First run with checkpoint_comment
    # =================================================================
    log_info('-- Phase 1: First run with checkpoint_comment')

    evolve1 = Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    )

    try:
        run1 = await evolve1.run(
            prompt="Create a file called dx-test.txt with the content 'DX v3.3 checkpoint test'",
            timeout_ms=TIMEOUT,
            checkpoint_comment='initial setup',
        )

        assert_true(run1.exit_code == 0, 'run1 exits 0')
        assert_true(run1.checkpoint is not None, 'run1.checkpoint is defined')

        checkpoint1 = run1.checkpoint
        assert_true(checkpoint1.id is not None, 'checkpoint1.id is defined')
        assert_true(checkpoint1.comment == 'initial setup', "checkpoint1.comment = 'initial setup'")
        assert_true(checkpoint1.parent_id is None, 'checkpoint1.parent_id is None (first checkpoint)')
        assert_true(checkpoint1.agent_type == 'claude', 'checkpoint1.agent_type is claude')

        log_result(True, f'Checkpoint 1: id={checkpoint1.id}, comment={checkpoint1.comment}')

        # =================================================================
        # Phase 2: Second run -- verify parent_id lineage
        # =================================================================
        log_info('-- Phase 2: Second run verifying parent_id lineage')

        run2 = await evolve1.run(
            prompt="Append ' - verified' to the end of dx-test.txt",
            timeout_ms=TIMEOUT,
            checkpoint_comment='verification pass',
        )

        assert_true(run2.exit_code == 0, 'run2 exits 0')
        assert_true(run2.checkpoint is not None, 'run2.checkpoint is defined')

        checkpoint2 = run2.checkpoint
        assert_true(
            checkpoint2.parent_id == checkpoint1.id,
            'checkpoint2.parent_id = checkpoint1.id (lineage)',
        )
        assert_true(
            checkpoint2.comment == 'verification pass',
            "checkpoint2.comment = 'verification pass'",
        )

        log_result(True, f'Checkpoint 2: id={checkpoint2.id}, parent_id={checkpoint2.parent_id}')

        # =================================================================
        # Phase 3: Explicit checkpoint with comment
        # =================================================================
        log_info('-- Phase 3: Explicit checkpoint with comment')

        checkpoint3 = await evolve1.checkpoint(comment='manual snapshot')

        assert_true(checkpoint3.id is not None, 'checkpoint3.id is defined')
        assert_true(checkpoint3.comment == 'manual snapshot', "checkpoint3.comment = 'manual snapshot'")
        assert_true(
            checkpoint3.parent_id == checkpoint2.id,
            'checkpoint3.parent_id = checkpoint2.id',
        )

        log_result(True, f'Checkpoint 3: id={checkpoint3.id}, parent_id={checkpoint3.parent_id}')

    finally:
        try:
            await evolve1.kill()
        except Exception:
            pass

    log_result(True, 'Phase 3 complete')

    # =================================================================
    # Phase 4: list_checkpoints() standalone (with tag filter)
    # =================================================================
    log_info('-- Phase 4: list_checkpoints() standalone')

    test_tag = checkpoint1.tag
    log_info(f'Using tag filter: {test_tag}')
    all_checkpoints = await list_checkpoints(storage=storage_config, tag=test_tag)
    assert_true(
        len(all_checkpoints) >= 3,
        f'list_checkpoints() returned >= 3 (got {len(all_checkpoints)})',
    )
    assert_true(all_checkpoints[0].id == checkpoint3.id, 'First result is checkpoint3 (newest)')
    assert_true(all_checkpoints[1].id == checkpoint2.id, 'Second result is checkpoint2')
    assert_true(all_checkpoints[2].id == checkpoint1.id, 'Third result is checkpoint1 (oldest)')

    log_result(True, 'Phase 4 complete')

    # =================================================================
    # Phase 5: list_checkpoints() with limit
    # =================================================================
    log_info('-- Phase 5: list_checkpoints() with limit')

    limited = await list_checkpoints(storage=storage_config, limit=2, tag=test_tag)
    assert_true(len(limited) == 2, 'limit=2 returns 2 entries')
    assert_true(limited[0].id == checkpoint3.id, 'Limited: first is newest')

    log_result(True, 'Phase 5 complete')

    # =================================================================
    # Phase 6: Evolve.list_checkpoints() instance method
    # =================================================================
    log_info('-- Phase 6: Evolve.list_checkpoints()')

    evolve2 = Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    )

    try:
        instance_list = await evolve2.list_checkpoints(limit=1, tag=test_tag)
        assert_true(len(instance_list) == 1, 'Evolve.list_checkpoints(limit=1) returns 1')
        assert_true(instance_list[0].id == checkpoint3.id, 'Instance list returns newest checkpoint')
    finally:
        await evolve2.bridge.stop()

    log_result(True, 'Phase 6 complete')

    # =================================================================
    # Phase 7: from_checkpoint='latest' restores most recent
    # =================================================================
    log_info("-- Phase 7: from_checkpoint='latest' restores most recent")

    async with Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    ) as evolve3:
        log_info(f"Restoring from 'latest' (should resolve to {checkpoint3.id})...")
        run3 = await evolve3.run(
            prompt='Read the contents of dx-test.txt and tell me what it says.',
            from_checkpoint='latest',
            timeout_ms=TIMEOUT,
        )

        assert_true(run3.exit_code == 0, 'run3 exits 0')
        assert_true(run3.checkpoint is not None, 'run3 creates a new checkpoint after restore')
        assert_true(
            run3.checkpoint.parent_id == checkpoint3.id,
            'run3 checkpoint parent_id = checkpoint3.id (restored from latest)',
        )

    log_result(True, 'Phase 7 complete')
    log_result(True, 'All storage DX v3.3 tests passed')
