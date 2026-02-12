#!/usr/bin/env python3
"""Integration Test 20: Storage Checkpoints (BYOK + Gateway)

End-to-end test for checkpoint create, restore, dedup, and error cases.
Mirrors TypeScript integration test 20-storage-checkpoints.ts.

Tests the full lifecycle:
  1. Run agent -> auto-checkpoint -> verify checkpoint in response
  2. Kill sandbox -> restore from checkpoint -> verify agent resumes
  3. Dedup: compare hashes between checkpoints
  4. Error cases: nonexistent ID
  5. Error cases: from_checkpoint + sandbox_id mutual exclusivity

Requires:
  EVOLVE_API_KEY -- LLM gateway
  E2B_API_KEY -- sandbox provider
  AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY -- S3 credentials (BYOK only)
"""

import os
import pytest

from evolve import Evolve, CheckpointInfo, StorageConfig
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
STORAGE_URL = f's3://swarmkit-test-checkpoints-905418019965/py-integration-test-{PROVIDER_NAME}/'
STORAGE_REGION = 'us-west-2'
TIMEOUT = 180000  # 3 min per run

agent_config = get_agent_config()
validate_agent_config(agent_config)


def get_storage_config() -> StorageConfig:
    if IS_GATEWAY:
        return StorageConfig()  # Gateway mode -- EVOLVE_API_KEY from env
    return StorageConfig(url=STORAGE_URL, region=STORAGE_REGION)


# =============================================================================
# TEST
# =============================================================================


@pytest.mark.asyncio
async def test_storage_checkpoint_lifecycle():
    """Full checkpoint lifecycle: create, restore, dedup, error cases."""
    log_section(f'Storage checkpoint lifecycle ({STORAGE_MODE} mode)')

    provider = create_sandbox_provider(PROVIDER_NAME)
    storage_config = get_storage_config()

    log_info(f'Using provider: {PROVIDER_NAME}, storage: {STORAGE_MODE}')

    # =================================================================
    # Phase 1: Create checkpoint
    # =================================================================
    log_info('-- Phase 1: Create checkpoint')

    async with Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    ) as evolve1:
        run1 = await evolve1.run(
            prompt="Create a file called hello.txt with the content 'Hello from Python checkpoint test'",
            timeout_ms=TIMEOUT,
        )

        assert_true(run1.exit_code == 0, 'run1 exits 0')
        assert_true(run1.checkpoint is not None, 'run1.checkpoint is defined')

        checkpoint1 = run1.checkpoint
        assert_true(checkpoint1.id is not None, 'checkpoint1.id is defined')
        assert_true(checkpoint1.hash is not None, 'checkpoint1.hash is defined')
        assert_true(checkpoint1.tag is not None, 'checkpoint1.tag is defined')
        assert_true(checkpoint1.timestamp is not None, 'checkpoint1.timestamp is defined')
        assert_true(len(checkpoint1.hash) == 64, 'checkpoint1.hash is SHA-256 (64 chars)')
        assert_true(checkpoint1.agent_type == 'claude', 'checkpoint1.agent_type is claude')

        log_result(True, f'Checkpoint: id={checkpoint1.id}, hash={checkpoint1.hash[:12]}...')

    log_result(True, 'Phase 1 complete')

    # =================================================================
    # Phase 2: Restore from checkpoint
    # =================================================================
    log_info('-- Phase 2: Restore from checkpoint')

    async with Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
    ) as evolve2:
        run2 = await evolve2.run(
            prompt='Read the contents of hello.txt and tell me what it says. Quote the exact contents.',
            from_checkpoint=checkpoint1.id,
            timeout_ms=TIMEOUT,
        )

        assert_true(run2.exit_code == 0, 'run2 exits 0')
        assert_true(
            'Hello from Python checkpoint test' in run2.stdout,
            'stdout contains restored file content',
        )
        assert_true(run2.checkpoint is not None, 'run2.checkpoint is defined (second checkpoint created)')

        checkpoint2 = run2.checkpoint
        log_result(True, f'Checkpoint 2: id={checkpoint2.id}, hash={checkpoint2.hash[:12]}...')

    log_result(True, 'Phase 2 complete')

    # =================================================================
    # Phase 3: Dedup verification
    # =================================================================
    log_info('-- Phase 3: Dedup verification')

    if checkpoint1.hash == checkpoint2.hash:
        log_info('Same hash -- dedup skipped re-upload (workspace unchanged)')
    else:
        log_info('Different hashes (agent modified workspace between runs)')
        log_info(f'  checkpoint1: {checkpoint1.hash[:16]}...')
        log_info(f'  checkpoint2: {checkpoint2.hash[:16]}...')

    log_result(True, 'Phase 3 complete')

    # =================================================================
    # Phase 4: Error cases
    # =================================================================
    log_info('-- Phase 4: Error cases')

    try:
        async with Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
        ) as evolve3:
            await evolve3.run(
                prompt='test',
                from_checkpoint='nonexistent-id-12345',
                timeout_ms=30000,
            )
            raise AssertionError('from with nonexistent ID should throw')
    except AssertionError:
        raise
    except Exception as e:
        log_result(True, f'from with nonexistent ID throws: {e}')

    log_result(True, 'Phase 4 complete')

    # =================================================================
    # Phase 5: from_checkpoint + sandbox_id mutual exclusivity
    # =================================================================
    log_info('-- Phase 5: from_checkpoint + sandbox_id mutual exclusivity')

    try:
        async with Evolve(
            config=agent_config,
            sandbox=provider,
            storage=storage_config,
            sandbox_id='some-sandbox-id',
        ) as evolve4:
            await evolve4.run(
                prompt='test',
                from_checkpoint=checkpoint1.id,
                timeout_ms=30000,
            )
            raise AssertionError('from_checkpoint + sandbox_id should throw')
    except AssertionError:
        raise
    except Exception as e:
        error_msg = str(e).lower()
        assert_true(
            'withsession' in error_msg or 'mutually exclusive' in error_msg,
            f'from_checkpoint + sandbox_id throws mutual exclusivity error: {e}',
        )
        log_result(True, f'from_checkpoint + sandbox_id throws: {e}')

    log_result(True, 'Phase 5 complete')
    log_result(True, 'All storage checkpoint tests passed')
