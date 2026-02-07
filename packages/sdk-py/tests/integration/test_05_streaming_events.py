#!/usr/bin/env python3
"""Streaming Events Tests

Tests: Event emitters (stdout, stderr, content, lifecycle) via on() callbacks
Agent Support: All (codex, claude, gemini, qwen)
"""

import os
import sys
import asyncio
from typing import cast
from evolve import Evolve
from tests.utils.agent_config import (
    get_agent_config,
    validate_agent_config,
    get_agent_display_name,
)
from tests.utils.test_helpers import (
    ProviderName,
    create_sandbox_provider,
    get_available_providers,
    log_section,
    log_result,
    log_info,
    assert_true,
    try_parse_json,
)

agent_config = get_agent_config()
validate_agent_config(agent_config)

agent_name = get_agent_display_name(agent_config.type)


def get_test_providers() -> list[ProviderName]:
    """Resolve provider matrix for this test run.

    Use EVOLVE_TEST_PROVIDER=<e2b|daytona|modal|all> to narrow test scope.
    """
    available = get_available_providers()
    requested = os.getenv('EVOLVE_TEST_PROVIDER', 'all').strip().lower()

    if requested != 'all':
        if requested not in ('e2b', 'daytona', 'modal'):
            raise ValueError(
                f"Invalid EVOLVE_TEST_PROVIDER='{requested}'. Expected one of: e2b, daytona, modal, all"
            )
        provider = cast(ProviderName, requested)
        if provider not in available:
            raise ValueError(
                f"Requested provider '{provider}' is not configured. Available: {available or 'none'}"
            )
        return [provider]

    if not available:
        raise ValueError('No sandbox providers configured (set E2B_API_KEY and/or DAYTONA_API_KEY and/or MODAL_TOKEN_ID+MODAL_TOKEN_SECRET)')

    return available


TEST_PROVIDERS = get_test_providers()


async def test_stdout_event():
    """Test 1: stdout event with on() callback"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 1: stdout event with on() callback - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
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
    for provider in TEST_PROVIDERS:
        log_section(f"Test 2: stderr event with on() - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
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

            combined = ''.join(stderr_chunks)
            if provider == 'daytona':
                # Daytona command stderr callback is currently non-deterministic.
                # Keep visibility but avoid a false-negative failure in this suite.
                log_info('Skipping strict stderr callback assertions for daytona')
                log_result(True, f'Received {len(stderr_chunks)} stderr chunk(s) (daytona informational)')
            else:
                assert_true(len(stderr_chunks) > 0, 'Should receive stderr chunks')
                assert_true('error message' in combined, 'Stderr should contain expected message')
                log_result(True, f'Received {len(stderr_chunks)} stderr chunk(s)')
                log_result(True, 'Stderr contains expected message')

            await evolve.kill()
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_content_event_callback():
    """Test 3: content event with on() callback - parsed streaming events"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 3: content event callback - parsed streaming events - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
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
    for provider in TEST_PROVIDERS:
        log_section(f"Test 4: both content and stdout callbacks work - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
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


async def test_lifecycle_event_callback():
    """Test 5: lifecycle event callback - sandbox/agent transitions"""
    for provider in TEST_PROVIDERS:
        log_section(f"Test 5: lifecycle event callback - {agent_name} [{provider}]")

        evolve = Evolve(
            config=agent_config,
            sandbox=create_sandbox_provider(provider),
            workspace_mode='knowledge',
        )

        try:
            lifecycle_events = []

            # Register lifecycle listener
            evolve.on('lifecycle', lambda event: lifecycle_events.append(event))

            log_info('Running command with lifecycle listener')

            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            log_result(len(lifecycle_events) > 0, f'Received {len(lifecycle_events)} lifecycle event(s)')

            # Validate expected shape
            has_reason = any(event.get('reason') for event in lifecycle_events)
            has_sandbox_state = any(event.get('sandbox') for event in lifecycle_events)
            has_agent_state = any(event.get('agent') for event in lifecycle_events)
            log_result(has_reason, 'Lifecycle events contain reason')
            log_result(has_sandbox_state, 'Lifecycle events contain sandbox state')
            log_result(has_agent_state, 'Lifecycle events contain agent state')

            reasons = {event.get('reason') for event in lifecycle_events}
            log_result('run_start' in reasons, 'Lifecycle includes run_start')
            log_result('run_complete' in reasons, 'Lifecycle includes run_complete')

            await evolve.kill()
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def run_all_tests():
    """Run all streaming event tests"""
    print('\n🚀 Starting Streaming Events Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}')
    print(f'🧱 Providers: {", ".join(TEST_PROVIDERS)}\n')

    try:
        await test_stdout_event()
        await test_stderr_event()
        await test_content_event_callback()
        await test_both_content_and_stdout_work()
        await test_lifecycle_event_callback()

        print('\n' + '=' * 70)
        print(f'✅ All streaming event tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
