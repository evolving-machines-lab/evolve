#!/usr/bin/env python3
"""Basic SDK Method Tests

Tests: run(), execute_command(), withSecrets(), get_host()
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


async def test_run_method():
    """Test 1: Basic run() method"""
    log_section(f"Test 1: Basic run() method - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Sending prompt: "Create a hello.txt file inside the output/ folder with content "Hello world!""')

            result = await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,  # 2 minutes
            )

            log_result(True, 'run() executed successfully')
            log_result(result.exit_code == 0, f'Exit code: {result.exit_code}')
            log_result(bool(result.sandbox_id), f'Sandbox ID: {result.sandbox_id}')
            log_result(len(result.stdout) > 0, f'Stdout length: {len(result.stdout)} chars')

            assert_true(result.exit_code == 0, 'Expected exit code 0')
            assert_true(len(result.sandbox_id) > 0, 'Expected non-empty sandbox ID')

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_execute_command():
    """Test 2: execute_command() method"""
    log_section(f"Test 2: execute_command() method - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Executing: echo "Direct command test"')

            result = await evolve.execute_command(
                'echo "Direct command test"',
                timeout_ms=30000,
            )

            log_result(True, 'execute_command() executed successfully')
            log_result(result.exit_code == 0, f'Exit code: {result.exit_code}')
            log_result('Direct command test' in result.stdout, 'Stdout contains expected text')

            assert_true(result.exit_code == 0, 'Expected exit code 0')
            assert_true('Direct command test' in result.stdout, 'Expected output in stdout')

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_multi_turn_conversation():
    """Test 3: Multi-turn conversation"""
    log_section(f"Test 3: Multi-turn conversation - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            # First turn
            log_info('Turn 1: Creating first file')

            result1 = await evolve.run(
                prompt='Create a hello1.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            assert_true(result1.exit_code == 0, 'First turn should succeed')
            log_result(True, f'Turn 1 completed (sandbox: {result1.sandbox_id})')

            # Second turn - all agents auto-resume now
            log_info('Turn 2: Creating second file (auto-resume)')

            result2 = await evolve.run(
                prompt='Create a hello2.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            assert_true(result2.exit_code == 0, 'Second turn should succeed')
            log_result(True, f'Turn 2 completed with auto-resume (sandbox: {result2.sandbox_id})')
            log_result(result1.sandbox_id == result2.sandbox_id, 'Used same sandbox for both turns')

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_execute_command_with_working_directory():
    """Test 4: execute_command() respects working directory"""
    log_section(f"Test 4: execute_command() respects working directory - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        working_directory='/home/user/workspace',
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Executing: pwd (should show working directory)')

            result = await evolve.execute_command('pwd', timeout_ms=30000)

            log_result(result.exit_code == 0, f'Exit code: {result.exit_code}')
            log_result(
                '/home/user/workspace' in result.stdout,
                f'Working directory is correct: {result.stdout.strip()}'
            )

            assert_true(result.exit_code == 0, 'Expected exit code 0')
            assert_true(
                '/home/user/workspace' in result.stdout,
                'Expected /home/user/workspace in output'
            )

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_secrets_available():
    """Test 5: withSecrets() - environment secrets"""
    log_section(f"Test 5: withSecrets() - environment secrets - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        secrets={
            'MY_SECRET': 'test-secret-value',
            'API_KEY': 'secret-api-key-123',
        },
    ) as evolve:
        try:
            log_info('Testing secret availability in sandbox')

            # Test first secret
            result1 = await evolve.execute_command('echo $MY_SECRET', timeout_ms=30000)

            log_result(result1.exit_code == 0, f'Exit code: {result1.exit_code}')
            log_result(
                'test-secret-value' in result1.stdout,
                f'MY_SECRET is accessible: {result1.stdout.strip()}'
            )

            assert_true(result1.exit_code == 0, 'Expected exit code 0')
            assert_true(
                'test-secret-value' in result1.stdout,
                'Expected MY_SECRET to be accessible'
            )

            # Test second secret
            result2 = await evolve.execute_command('echo $API_KEY', timeout_ms=30000)

            log_result(
                'secret-api-key-123' in result2.stdout,
                f'API_KEY is accessible: {result2.stdout.strip()}'
            )

            assert_true(
                'secret-api-key-123' in result2.stdout,
                'Expected API_KEY to be accessible'
            )

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_get_host():
    """Test 6: get_host() - port forwarding URL"""
    log_section(f"Test 6: get_host() - port forwarding URL - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
    ) as evolve:
        try:
            log_info('Getting public host URL for port 8000')

            # get_host() returns the hostname (not full URL) for port forwarding
            # This tests the API method itself, not whether a server is running
            host = await evolve.get_host(8000)

            log_result(bool(host), f'Host received: {host}')
            log_result('8000' in host, 'Port number in hostname')
            log_result('.e2b.app' in host or '.' in host, 'Valid hostname format')

            assert_true(len(host) > 0, 'Expected non-empty host')
            assert_true('8000' in host, 'Expected host to reference port 8000')
            assert_true('.' in host, 'Expected host to be a valid hostname')

            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def run_all_tests():
    """Run all basic method tests"""
    print('\n🚀 Starting Basic SDK Method Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}\n')

    try:
        await test_run_method()
        await test_execute_command()
        await test_multi_turn_conversation()
        await test_execute_command_with_working_directory()
        await test_secrets_available()
        await test_get_host()

        print('\n' + '=' * 70)
        print(f'✅ All basic method tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
