#!/usr/bin/env python3
"""Integration Test 21: Storage Restore Fidelity (BYOK + Gateway)

Verifies that checkpoint restore preserves the full agent environment.
Mirrors TypeScript integration test 21-storage-restore-fidelity.ts.

Tests:
  1. Run agent with skills + workspace mode -> create checkpoint
  2. Restore from checkpoint -> verify conversation memory, file content,
     and re-checkpointing all work
  3. Inspect sandbox filesystem directly -> verify session history,
     skills directories exist

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
STORAGE_URL = f's3://swarmkit-test-checkpoints-905418019965/py-integration-test-fidelity-{PROVIDER_NAME}/'
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
async def test_storage_restore_fidelity():
    """Verify checkpoint restore preserves full agent environment."""
    log_section(f'Storage restore fidelity ({STORAGE_MODE} mode)')

    provider = create_sandbox_provider(PROVIDER_NAME)
    storage_config = get_storage_config()

    log_info(f'Using provider: {PROVIDER_NAME}, storage: {STORAGE_MODE}')

    # =================================================================
    # Phase 1: Initial run with skills + workspace mode
    # =================================================================
    log_info('-- Phase 1: Initial run with skills + workspace mode')

    async with Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
        skills=['pdf'],
        workspace_mode='swe',
    ) as evolve1:
        run1 = await evolve1.run(
            prompt="Create a file called identity.txt containing 'The secret passphrase is: purple-elephant-42'. Remember this passphrase -- I will ask you about it later.",
            timeout_ms=TIMEOUT,
        )

        assert_true(run1.exit_code == 0, 'run1 exits 0')
        assert_true(run1.checkpoint is not None, 'run1.checkpoint is defined')

        checkpoint1 = run1.checkpoint
        assert_true(checkpoint1.id is not None, 'checkpoint1.id is defined')
        assert_true(checkpoint1.hash is not None, 'checkpoint1.hash is defined')
        assert_true(len(checkpoint1.hash) == 64, 'checkpoint1.hash is SHA-256 (64 chars)')
        assert_true(checkpoint1.agent_type == 'claude', 'checkpoint1.agent_type is claude')

        log_result(True, f'Checkpoint: id={checkpoint1.id}, hash={checkpoint1.hash[:12]}...')

    log_result(True, 'Phase 1 complete')

    # =================================================================
    # Phase 2: Restore and verify conversation memory + file content
    # =================================================================
    log_info('-- Phase 2: Restore and verify conversation memory + file content')

    evolve2 = Evolve(
        config=agent_config,
        sandbox=provider,
        storage=storage_config,
        skills=['pdf'],
        workspace_mode='swe',
    )

    try:
        run2 = await evolve2.run(
            prompt='\n'.join([
                'Answer these questions:',
                '1. What is the secret passphrase I told you earlier?',
                '2. Read identity.txt and tell me its contents.',
                "3. List what's in your ~/.claude/ directory.",
                'Include the exact passphrase in your response.',
            ]),
            from_checkpoint=checkpoint1.id,
            timeout_ms=TIMEOUT,
        )

        assert_true(run2.exit_code == 0, 'run2 exits 0')
        assert_true(
            'purple-elephant-42' in run2.stdout,
            'stdout contains passphrase (conversation memory works)',
        )
        assert_true(
            'identity.txt' in run2.stdout,
            'stdout references identity.txt (file restored)',
        )
        assert_true(
            run2.checkpoint is not None,
            'run2.checkpoint is defined (re-checkpointing works after restore)',
        )

        log_result(True, f'Checkpoint 2: id={run2.checkpoint.id}, hash={run2.checkpoint.hash[:12]}...')
        log_result(True, 'Phase 2 complete')

        # =================================================================
        # Phase 3: Inspect sandbox filesystem directly
        # =================================================================
        log_info('-- Phase 3: Inspect sandbox filesystem directly')

        # Check skills directory
        skills_check = await evolve2.execute_command(
            "ls ~/.claude/skills/ 2>/dev/null || echo 'no skills dir'"
        )
        log_info(f'Skills dir: {skills_check.stdout.strip()[:200]}')

        # Check session history exists
        sessions_check = await evolve2.execute_command(
            "find ~/.claude/projects/ -name '*.jsonl' 2>/dev/null | head -5 || echo 'no sessions'"
        )
        log_info(f'Session files: {sessions_check.stdout.strip()[:200]}')

        session_output = sessions_check.stdout.strip()
        assert_true(
            session_output != 'no sessions' and '.jsonl' in session_output,
            'Session history .jsonl files exist',
        )

        # Check identity.txt is still there
        file_check = await evolve2.execute_command(
            "find ~/workspace -name 'identity.txt' -exec cat {} \\; 2>/dev/null || echo 'file missing'"
        )
        assert_true(
            'purple-elephant-42' in file_check.stdout,
            'identity.txt still on disk after restore',
        )

        log_result(True, 'Phase 3 complete')
    finally:
        try:
            await evolve2.kill()
        except Exception:
            pass

    log_result(True, 'All storage restore fidelity tests passed')
