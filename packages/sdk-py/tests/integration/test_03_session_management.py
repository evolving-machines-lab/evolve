#!/usr/bin/env python3
"""Session Management Tests

Tests: get_session(), set_session(), pause(), resume(), kill()
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
)

agent_config = get_agent_config()
validate_agent_config(agent_config)

agent_name = get_agent_display_name(agent_config.type)


async def test_get_session():
    """Test 1: get_session() - retrieve sandbox ID"""
    log_section(f"Test 1: get_session() - retrieve sandbox ID - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            # Before initialization
            session_before = await evolve.get_session()
            log_result(session_before is None, f'Session before init: {session_before}')

            # Run a command to initialize sandbox
            log_info('Initializing sandbox with run()')
            result = await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # After initialization
            session_after = await evolve.get_session()
            log_result(session_after is not None, f'Session after init: {session_after}')
            log_result(session_after == result.sandbox_id, 'Session ID matches result sandbox ID')

            assert_true(session_after is not None, 'Session should exist after run()')
            assert_true(session_after == result.sandbox_id, 'Session ID should match')

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_set_session():
    """Test 2: set_session() - reconnect to existing sandbox"""
    log_section(f"Test 2: set_session() - reconnect to existing sandbox - {agent_name}")

    saved_session_id = None

    # Create first Evolve instance (NO context manager - manual lifecycle)
    evolve1 = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        log_info('Step 1: Create sandbox and save session ID')

        # Create a file in first session
        await evolve1.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )

        saved_session_id = await evolve1.get_session()
        assert_true(saved_session_id is not None, 'Session ID should exist')

        log_result(True, f'Session 1 created: {saved_session_id}')

        # Don't kill - leave sandbox running for reconnection test
        log_info('Leaving sandbox running (not calling kill())')

        # Create second Evolve instance and reconnect
        log_info('Step 2: Create new Evolve instance and reconnect')

        evolve2 = Evolve(
            config=agent_config,
            sandbox=E2BProvider(api_key=get_e2b_api_key()),
            workspace_mode='knowledge',
            sandbox_id=saved_session_id,  # Reconnect to same sandbox
        )

        # Verify reconnection worked by reading the file
        result = await evolve2.execute_command(
            'cat /home/user/workspace/output/hello.txt'
        )

        assert_true(result.exit_code == 0, 'File should exist in reconnected session')
        assert_true('Hello world' in result.stdout, 'File content should be preserved')

        log_result(True, 'Successfully reconnected to existing sandbox')
        log_result(True, 'File from first session is accessible')

        # Clean up - evolve2 kills the sandbox, evolve1.kill() cleans up its bridge
        await evolve2.kill()
        await evolve1.kill()  # Sandbox already gone, but bridge cleanup still happens
        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_pause_resume():
    """Test 3: pause() and resume() - suspend/resume sandbox"""
    log_section(f"Test 3: pause() and resume() - suspend/resume sandbox - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Step 1: Initialize sandbox and create file')

            # Initialize sandbox
            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            session_id = await evolve.get_session()
            log_result(True, f'Sandbox created: {session_id}')

            # Pause sandbox
            log_info('Step 2: Pausing sandbox')
            await evolve.pause()
            log_result(True, 'Sandbox paused successfully')

            # Resume sandbox
            log_info('Step 3: Resuming sandbox')
            await evolve.resume()
            log_result(True, 'Sandbox resumed successfully')

            # Verify sandbox still works
            log_info('Step 4: Verifying sandbox after resume')
            result = await evolve.execute_command(
                'cat /home/user/workspace/output/hello.txt'
            )

            assert_true(result.exit_code == 0, 'File should exist after resume')
            assert_true('Hello world' in result.stdout, 'File content should be preserved')

            log_result(True, 'Sandbox state preserved after pause/resume')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_kill():
    """Test 4: kill() - terminate sandbox"""
    log_section(f"Test 4: kill() - terminate sandbox - {agent_name}")

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        log_info('Creating sandbox')

        # Initialize sandbox
        await evolve.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )

        session_id = await evolve.get_session()
        log_result(True, f'Sandbox created: {session_id}')

        # Kill sandbox
        log_info('Killing sandbox')
        await evolve.kill()
        log_result(True, 'Sandbox killed successfully')

        # Verify new run creates new sandbox
        log_info('Running again (should create new sandbox)')
        await evolve.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )

        new_session_id = await evolve.get_session()
        log_result(new_session_id != session_id, f'New sandbox created: {new_session_id}')

        assert_true(new_session_id != session_id, 'Should create new sandbox after kill()')

        await evolve.kill()
        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def test_multiple_session_switching():
    """Test 5: Switch between multiple sandboxes"""
    log_section(f"Test 5: Switch between multiple sandboxes - {agent_name}")

    session_a = None
    session_b = None

    evolve = Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    )

    try:
        # Create Session A
        log_info('Step 1: Creating Session A')
        await evolve.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )
        session_a = await evolve.get_session()
        log_result(True, f'Session A created: {session_a}')

        # Create Session B using a second Evolve instance
        # Note: We create a NEW instance but DON'T kill Session A
        log_info('Step 2: Creating Session B with new Evolve instance')

        evolve2 = Evolve(
            config=agent_config,
            sandbox=E2BProvider(api_key=get_e2b_api_key()),
            workspace_mode='knowledge',
        )

        await evolve2.run(
            prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
            timeout_ms=120000,
        )
        session_b = await evolve2.get_session()
        log_result(True, f'Session B created: {session_b}')
        assert_true(session_a != session_b, 'Sessions should be different')

        # Switch back to Session A
        log_info('Step 3: Switching back to Session A')
        await evolve.set_session(session_a)

        result_a = await evolve.execute_command(
            'cat /home/user/workspace/output/hello.txt'
        )
        assert_true('Hello world' in result_a.stdout, 'Should access Session A files')
        log_result(True, 'Successfully switched to Session A')

        # Switch to Session B
        log_info('Step 4: Switching to Session B')
        await evolve.set_session(session_b)

        result_b = await evolve.execute_command(
            'cat /home/user/workspace/output/hello.txt'
        )
        assert_true('Hello world' in result_b.stdout, 'Should access Session B files')
        log_result(True, 'Successfully switched to Session B')

        # Clean up both sessions
        await evolve.set_session(session_a)
        await evolve.kill()
        await evolve2.kill()

        log_result(True, 'Test completed successfully')
    except Exception as error:
        log_result(False, 'Test failed', error)
        raise


async def run_all_tests():
    """Run all session management tests"""
    print('\n🚀 Starting Session Management Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}\n')

    try:
        await test_get_session()
        await test_set_session()
        await test_pause_resume()
        await test_kill()
        await test_multiple_session_switching()

        print('\n' + '=' * 70)
        print(f'✅ All session management tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
