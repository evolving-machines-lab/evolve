#!/usr/bin/env python3
"""Streaming Events Tests

Tests: Event emitters (stdout, stderr, content) via on() callbacks
Agent Support: All (codex, claude, gemini, qwen)
"""

import sys
import asyncio
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
    try_parse_json,
)

agent_config = get_agent_config()
validate_agent_config(agent_config)

agent_name = get_agent_display_name(agent_config.type)


async def test_stdout_event():
    """Test 1: stdout event with on() callback"""
    log_section(f"Test 1: stdout event with on() callback - {agent_name}")

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        stdout_chunks = []

        # Register stdout listener
        evolve.on('stdout', lambda chunk: stdout_chunks.append(chunk))

        log_info('Running command with stdout listener')

        await evolve.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )

        log_result(len(stdout_chunks) > 0, f'Received {len(stdout_chunks)} stdout chunk(s)')

        # Stdout should contain JSON streaming data (for JSON agents)
        has_json_chunks = any(try_parse_json(chunk) is not None for chunk in stdout_chunks)

        log_result(has_json_chunks, 'Stdout contains JSON streaming data')

        await evolve.kill()
        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_stderr_event():
    """Test 2: stderr event"""
    log_section(f"Test 2: stderr event with on() - {agent_name}")

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        stderr_chunks = []

        # Register stderr listener
        evolve.on('stderr', lambda chunk: stderr_chunks.append(chunk))

        log_info('Running execute_command that outputs to stderr')

        await evolve.execute_command(
            'echo "error message" >&2',
            timeout_ms=30000,
        )

        log_result(len(stderr_chunks) > 0, f'Received {len(stderr_chunks)} stderr chunk(s)')

        combined = ''.join(stderr_chunks)
        log_result('error message' in combined, 'Stderr contains expected message')

        await evolve.kill()
        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_content_event_callback():
    """Test 3: content event with on() callback - parsed streaming events"""
    log_section(f"Test 3: content event callback - parsed streaming events - {agent_name}")

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        content_events = []

        # Register content listener
        evolve.on('content', lambda event: content_events.append(event))

        log_info('Running command with content listener')

        await evolve.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )

        log_result(len(content_events) > 0, f'Received {len(content_events)} content event(s)')

        # Content events should have update['sessionUpdate'] field
        has_valid_events = any(
            event.get('update', {}).get('sessionUpdate')
            for event in content_events
        )
        log_result(has_valid_events, "Content events have update['sessionUpdate'] field")

        # Check for agent_message_chunk (most common)
        has_message_chunk = any(
            event.get('update', {}).get('sessionUpdate') == 'agent_message_chunk'
            for event in content_events
        )
        log_result(has_message_chunk, 'Received agent_message_chunk event')

        # Log event types received
        event_types = set(
            event.get('update', {}).get('sessionUpdate')
            for event in content_events
            if event.get('update', {}).get('sessionUpdate')
        )
        log_info(f'Event types received: {", ".join(sorted(event_types))}')

        await evolve.kill()
        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_both_content_and_stdout_work():
    """Test 4: both content and stdout can be used together"""
    log_section(f"Test 4: both content and stdout callbacks work - {agent_name}")

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        content_events = []
        stdout_chunks = []

        # Register BOTH content and stdout listeners - both should receive events
        evolve.on('content', lambda event: content_events.append(event))
        evolve.on('stdout', lambda chunk: stdout_chunks.append(chunk))

        log_info('Running with both content and stdout listeners')

        await evolve.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )

        log_result(len(content_events) > 0, f'Received {len(content_events)} content event(s)')
        log_result(len(stdout_chunks) > 0, f'Received {len(stdout_chunks)} stdout chunk(s)')

        # Both should receive events (events always forwarded for robustness)
        log_result(
            len(content_events) > 0 and len(stdout_chunks) > 0,
            'Both content and stdout callbacks receive events'
        )

        await evolve.kill()
        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def run_all_tests():
    """Run all streaming event tests"""
    print('\n🚀 Starting Streaming Events Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}\n')

    try:
        await test_stdout_event()
        await test_stderr_event()
        await test_content_event_callback()
        await test_both_content_and_stdout_work()

        print('\n' + '=' * 70)
        print(f'✅ All streaming event tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
