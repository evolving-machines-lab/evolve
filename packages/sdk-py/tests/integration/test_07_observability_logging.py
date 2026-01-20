#!/usr/bin/env python3
"""Observability Logging Tests

Tests: SessionLogger behavior, log file creation, tag lifecycle
Agent Support: All (codex, claude, gemini, qwen)
"""

import sys
import asyncio
import json
from pathlib import Path
from typing import List, Optional, Dict, Any
from evolve import Evolve, E2BProvider
from tests.utils.agent_config import (
    get_agent_config,
    validate_agent_config,
    get_agent_display_name,
)
from tests.utils.test_helpers import (
    get_e2b_api_key,
    log_section,
    log_result,
    log_info,
    assert_true,
    sleep,
)

agent_config = get_agent_config()
validate_agent_config(agent_config)

agent_name = get_agent_display_name(agent_config.type)
observability_dir = Path.home() / '.evolve' / 'observability' / 'sessions'


def cleanup_test_logs() -> None:
    """Clean up test log files."""
    if not observability_dir.exists():
        return

    test_prefixes = ['test-obs-1', 'test-obs-2', 'test-obs-3', 'test-obs-4', 'test-obs-5']

    for file_path in observability_dir.glob('*.jsonl'):
        if any(file_path.name.startswith(prefix) for prefix in test_prefixes):
            try:
                file_path.unlink()
            except Exception:
                # Ignore errors
                pass


def find_log_files(tag_prefix: Optional[str] = None) -> List[str]:
    """Find log files matching a tag prefix.

    Args:
        tag_prefix: Optional tag prefix to filter by

    Returns:
        List of log file names
    """
    if not observability_dir.exists():
        return []

    all_files = list(observability_dir.glob('*.jsonl'))

    if tag_prefix:
        return [f.name for f in all_files if f.name.startswith(tag_prefix)]

    return [f.name for f in all_files]


def read_log_file(filename: str) -> List[Dict[str, Any]]:
    """Read and parse JSONL log file.

    Args:
        filename: Log file name

    Returns:
        List of parsed JSON entries
    """
    file_path = observability_dir / filename
    content = file_path.read_text(encoding='utf-8')

    entries = []
    for line in content.strip().split('\n'):
        if line.strip():
            entries.append(json.loads(line))

    return entries


async def wait_for_log_file(
    tag_prefix: str,
    min_entries: int = 1,
    max_wait_ms: int = 5000
) -> Optional[str]:
    """Wait for log file to be written and closed.

    Args:
        tag_prefix: Tag prefix to search for
        min_entries: Minimum number of entries expected
        max_wait_ms: Maximum wait time in milliseconds

    Returns:
        Log file name or None if not found
    """
    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) * 1000 < max_wait_ms:
        files = find_log_files(tag_prefix)
        if files:
            # Check if file has expected entries
            try:
                entries = read_log_file(files[0])
                if len(entries) >= min_entries:
                    return files[0]
            except Exception:
                # File might still be writing
                pass
        await sleep(200)

    return None


async def test_log_file_creation():
    """Test 1: Log file creation with tag prefix"""
    log_section(f"Test 1: Log file creation with tag prefix - {agent_name}")

    tag_prefix = 'test-obs-1'
    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        session_tag_prefix=tag_prefix,
    )

    try:
        log_info('Running agent with custom tag prefix')

        await evolve.run(
            prompt='Say hello in one word',
            timeout_ms=120000,
        )

        # Get the session tag
        session_tag = await evolve.get_session_tag()
        assert_true(session_tag is not None, 'Session tag should exist')
        log_result(True, f'Session tag: {session_tag}')

        # Verify tag starts with our prefix
        assert_true(session_tag.startswith(tag_prefix), f'Tag should start with "{tag_prefix}"')
        log_result(True, f'Tag has correct prefix: {session_tag}')

        # Kill and wait for log file to be written
        await evolve.kill()  # This should flush logs
        log_file = await wait_for_log_file(tag_prefix, 3)  # Wait for metadata + prompt + events
        assert_true(log_file is not None, 'Log file should be created')
        log_result(True, f'Log file created: {log_file}')

        # Parse and validate log content
        entries = read_log_file(log_file)
        log_info(f'Log has {len(entries)} entries')

        # Validate structure
        metadata = entries[0]
        assert_true('_meta' in metadata, 'First entry should be metadata')
        assert_true(metadata['_meta']['tag'] == session_tag, 'Metadata tag should match session tag')
        assert_true(metadata['_meta']['agent'] == agent_config.type, 'Metadata agent should match')
        log_result(True, 'Metadata entry is correct')

        prompt = entries[1]
        assert_true('_prompt' in prompt, 'Second entry should be prompt')
        assert_true(prompt['_prompt']['text'] == 'Say hello in one word', 'Prompt text should match')
        log_result(True, 'Prompt entry is correct')

        # Should have at least some event entries
        event_entries = entries[2:]
        assert_true(len(event_entries) > 0, 'Should have at least one event entry')
        log_result(True, f'Found {len(event_entries)} event entries')

        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_multi_turn_same_file():
    """Test 2: Multi-turn logs to same file"""
    log_section(f"Test 2: Multi-turn logs to same file - {agent_name}")

    tag_prefix = 'test-obs-2'
    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        session_tag_prefix=tag_prefix,
    )

    try:
        log_info('Running first turn')
        await evolve.run(
            prompt='Say "first"',
            timeout_ms=120000,
        )

        session_tag1 = await evolve.get_session_tag()
        log_result(True, f'First turn tag: {session_tag1}')

        log_info('Running second turn (same session)')
        await evolve.run(
            prompt='Say "second"',
            timeout_ms=120000,
        )

        session_tag2 = await evolve.get_session_tag()
        assert_true(session_tag1 == session_tag2, 'Tags should be same for multi-turn')
        log_result(True, 'Same tag used for second turn')

        # Flush logs
        await sleep(500)
        await evolve.kill()
        await sleep(200)

        # Should still have exactly 1 log file
        log_files = find_log_files(tag_prefix)
        assert_true(len(log_files) == 1, f'Should have exactly 1 log file, found {len(log_files)}')
        log_result(True, 'Only one log file created for multi-turn session')

        # Verify both prompts are in the file
        entries = read_log_file(log_files[0])
        prompts = [e for e in entries if '_prompt' in e]
        assert_true(len(prompts) == 2, f'Should have 2 prompts, found {len(prompts)}')
        assert_true(prompts[0]['_prompt']['text'] == 'Say "first"', 'First prompt should match')
        assert_true(prompts[1]['_prompt']['text'] == 'Say "second"', 'Second prompt should match')
        log_result(True, 'Both prompts logged to same file')

        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_kill_creates_new_file():
    """Test 3: Kill + run creates new file with new tag"""
    log_section(f"Test 3: Kill + run creates new file with new tag - {agent_name}")

    tag_prefix = 'test-obs-3'
    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        session_tag_prefix=tag_prefix,
    )

    try:
        log_info('Running first session')
        await evolve.run(
            prompt='Say "session1"',
            timeout_ms=120000,
        )

        session_tag1 = await evolve.get_session_tag()
        sandbox_id1 = await evolve.get_session()
        log_result(True, f'Session 1 - Tag: {session_tag1}, Sandbox: {sandbox_id1}')

        # Kill to end session
        log_info('Killing sandbox (ending session)')
        await sleep(500)
        await evolve.kill()
        await sleep(200)

        # Start new session
        log_info('Running second session (new sandbox)')
        await evolve.run(
            prompt='Say "session2"',
            timeout_ms=120000,
        )

        session_tag2 = await evolve.get_session_tag()
        sandbox_id2 = await evolve.get_session()
        log_result(True, f'Session 2 - Tag: {session_tag2}, Sandbox: {sandbox_id2}')

        # Tags should be different (new random hex)
        assert_true(session_tag1 != session_tag2, 'Tags should be different after kill')
        log_result(True, 'New tag generated after kill')

        # Sandbox IDs should be different
        assert_true(sandbox_id1 != sandbox_id2, 'Sandbox IDs should be different')
        log_result(True, 'New sandbox created after kill')

        # Both tags should have the same prefix
        assert_true(session_tag1.startswith(tag_prefix), 'First tag has prefix')
        assert_true(session_tag2.startswith(tag_prefix), 'Second tag has prefix')
        log_result(True, 'Both tags have correct prefix')

        # Flush second session logs
        await sleep(500)
        await evolve.kill()
        await sleep(200)

        # Should have 2 log files now
        log_files = find_log_files(tag_prefix)
        assert_true(len(log_files) == 2, f'Should have exactly 2 log files, found {len(log_files)}')
        log_result(True, f'Two separate log files created: {", ".join(log_files)}')

        # Verify each file has correct metadata
        for file in log_files:
            entries = read_log_file(file)
            metadata = entries[0]
            assert_true('_meta' in metadata, f'File {file} should have metadata')

            # Each file should have its own unique tag
            file_tag = metadata['_meta']['tag']
            log_result(True, f'File {file} has tag: {file_tag}')

        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_set_session_creates_new_file():
    """Test 4: set_session() creates new file"""
    log_section(f"Test 4: set_session() creates new file - {agent_name}")

    tag_prefix = 'test-obs-4'
    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        session_tag_prefix=tag_prefix,
    )

    try:
        log_info('Running first session')
        await evolve.run(
            prompt='Say "session1"',
            timeout_ms=120000,
        )

        session_tag1 = await evolve.get_session_tag()
        sandbox_id1 = await evolve.get_session()
        log_result(True, f'First session tag: {session_tag1}')

        # Don't kill - keep sandbox alive for set_session
        await sleep(500)

        # Call set_session with the same sandbox (simulates resuming)
        # This should reset the tag even though it's the same sandbox
        log_info('Calling set_session() to reset session state')
        await evolve.set_session(sandbox_id1)
        await sleep(200)

        tag_after_set = await evolve.get_session_tag()
        assert_true(tag_after_set is None, 'Tag should be None after set_session')
        log_result(True, 'Tag cleared after set_session')

        # Run again - should create new tag even though same sandbox
        log_info('Running again after set_session')
        await evolve.run(
            prompt='Say "session2"',
            timeout_ms=120000,
        )

        session_tag2 = await evolve.get_session_tag()
        log_result(True, f'Second session tag: {session_tag2}')

        # Should have different tags (set_session resets observability state)
        assert_true(session_tag1 != session_tag2, 'Tags should be different after set_session')
        log_result(True, 'New tag generated after set_session')

        await sleep(500)
        await evolve.kill()
        await sleep(200)

        # Should have 2 log files
        log_files = find_log_files(tag_prefix)
        assert_true(len(log_files) == 2, f'Should have 2 log files, found {len(log_files)}')
        log_result(True, 'Two separate log files created after set_session')

        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_no_tag_prefix():
    """Test 5: Works without custom tag prefix (uses default 'evolve-' prefix)"""
    log_section(f"Test 5: Works without custom tag prefix - {agent_name}")

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )
    # Note: NO session_tag_prefix parameter - SDK uses default 'evolve-' prefix

    try:
        log_info('Running without custom tag prefix')
        await evolve.run(
            prompt='Say hello',
            timeout_ms=120000,
        )

        session_tag = await evolve.get_session_tag()
        assert_true(session_tag is not None, 'Should have a tag even without custom prefix')
        log_result(True, f'Generated tag (default prefix): {session_tag}')

        # Tag should be 'evolve-' + 16 hex chars = 25 chars total
        import re
        assert_true(session_tag.startswith('evolve-'), 'Tag should have default evolve- prefix')
        assert_true(re.match(r'^evolve-[a-f0-9]{16}$', session_tag), 'Tag should be evolve-{16 hex}')
        log_result(True, 'Tag has valid default format (evolve-{hex})')

        await sleep(500)
        await evolve.kill()
        await sleep(200)

        # Should have created a log file
        all_files = find_log_files()
        recent_file = next((f for f in all_files if f.startswith(session_tag)), None)
        assert_true(recent_file is not None, 'Log file should exist')
        log_result(True, f'Log file created: {recent_file}')

        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def run_all_tests():
    """Run all observability tests sequentially."""
    log_section(f"🚀 Starting Observability Logging Tests - {agent_name}")
    log_info(f"Testing with agent: {agent_config.type}")
    log_info(f"Log directory: {observability_dir}")

    # Clean up old test log files
    log_info('Cleaning up old test log files...')
    cleanup_test_logs()

    try:
        await test_log_file_creation()
        await test_multi_turn_same_file()
        await test_kill_creates_new_file()
        await test_set_session_creates_new_file()
        await test_no_tag_prefix()

        log_section('✅ All Tests Passed!')
        return 0
    except Exception as error:
        log_section('❌ Tests Failed')
        print(error)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == '__main__':
    exit_code = asyncio.run(run_all_tests())
    sys.exit(exit_code)
