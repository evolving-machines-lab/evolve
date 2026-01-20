#!/usr/bin/env python3
"""Workspace Mode Tests

Tests: workspace_mode='knowledge', workspace_mode='swe'
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

# Map agent type to system prompt filename
SYSTEM_PROMPT_FILES = {
    'codex': 'AGENTS.md',
    'claude': 'CLAUDE.md',
    'gemini': 'GEMINI.md',
    'qwen': 'QWEN.md',
}


async def test_knowledge_mode_structure():
    """Test 1: Knowledge mode - directory structure"""
    log_section(f"Test 1: Knowledge mode - directory structure - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        working_directory='/home/user/workspace',
    ) as evolve:
        try:
            log_info('Initializing sandbox in knowledge mode')

            # Initialize sandbox
            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # Verify workspace directories exist
            log_info('Verifying workspace directories...')

            result = await evolve.execute_command('ls -la /home/user/workspace/')

            assert_true(result.exit_code == 0, 'ls command should succeed')

            output = result.stdout
            assert_true('output' in output, 'output/ directory should exist')
            assert_true('scripts' in output, 'scripts/ directory should exist')
            assert_true('context' in output, 'context/ directory should exist')
            assert_true('temp' in output, 'temp/ directory should exist')

            log_result(True, 'All workspace directories created')

            # Verify system prompt file exists
            prompt_file = SYSTEM_PROMPT_FILES[agent_config.type]
            log_info(f'Verifying system prompt file: {prompt_file}')

            prompt_check = await evolve.execute_command(
                f'test -f /home/user/workspace/{prompt_file} && echo "exists" || echo "not found"'
            )

            assert_true('exists' in prompt_check.stdout, f'{prompt_file} should exist')
            log_result(True, f'System prompt file {prompt_file} created')

            # Verify system prompt content
            prompt_content = await evolve.execute_command(
                f'cat /home/user/workspace/{prompt_file}'
            )

            assert_true(
                'output/' in prompt_content.stdout,
                'System prompt should mention output/ directory'
            )
            assert_true(
                'scripts/' in prompt_content.stdout,
                'System prompt should mention scripts/ directory'
            )

            log_result(True, 'System prompt contains workspace instructions')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_knowledge_mode_with_custom_prompt():
    """Test 2: Knowledge mode - custom system prompt"""
    log_section(f"Test 2: Knowledge mode - custom system prompt - {agent_name}")

    custom_prompt = 'You are a helpful coding assistant. Always be concise.'

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        system_prompt=custom_prompt,
    ) as evolve:
        try:
            log_info('Initializing sandbox with custom system prompt')

            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # Verify custom prompt is appended to default prompt
            prompt_file = SYSTEM_PROMPT_FILES[agent_config.type]
            prompt_content = await evolve.execute_command(
                f'cat /home/user/workspace/{prompt_file}'
            )

            assert_true(
                'output/' in prompt_content.stdout,
                'Should include default workspace instructions'
            )
            assert_true(
                custom_prompt in prompt_content.stdout,
                'Should include custom prompt'
            )

            log_result(True, 'Custom prompt appended to default prompt')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_swe_mode_structure():
    """Test 3: SWE mode - structure with repo/ folder"""
    log_section(f"Test 3: SWE mode - structure with repo/ folder - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='swe',
        working_directory='/home/user/workspace',
    ) as evolve:
        try:
            log_info('Initializing sandbox in SWE mode')

            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # Verify SWE mode directories are created (includes repo/)
            log_info('Verifying SWE mode directory structure...')

            result = await evolve.execute_command('ls -la /home/user/workspace/')

            assert_true(result.exit_code == 0, 'ls command should succeed')

            output = result.stdout
            # SWE mode creates the same folders as knowledge mode PLUS repo/
            assert_true('output' in output, 'output/ directory should exist')
            assert_true('scripts' in output, 'scripts/ directory should exist')
            assert_true('context' in output, 'context/ directory should exist')
            assert_true('temp' in output, 'temp/ directory should exist')
            assert_true('repo' in output, 'repo/ directory should exist (SWE mode)')

            log_result(True, 'SWE mode creates workspace directories including repo/')

            # Verify system prompt file exists with SWE workspace template
            prompt_file = SYSTEM_PROMPT_FILES[agent_config.type]
            prompt_check = await evolve.execute_command(
                f'cat /home/user/workspace/{prompt_file}'
            )

            assert_true(prompt_check.exit_code == 0, f'{prompt_file} should exist')
            assert_true(
                'repo/' in prompt_check.stdout,
                'SWE mode system prompt should include repo/ folder'
            )

            log_result(True, 'SWE mode system prompt includes repo/ folder')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_swe_mode_with_custom_prompt():
    """Test 4: SWE mode - custom prompt appended to workspace template"""
    log_section(f"Test 4: SWE mode - custom prompt appended - {agent_name}")

    custom_prompt = 'This is a clean repository. Follow coding best practices.'

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='swe',
        system_prompt=custom_prompt,
    ) as evolve:
        try:
            log_info('Initializing sandbox in SWE mode with custom prompt')

            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # Verify both SWE workspace template and custom prompt are present
            prompt_file = SYSTEM_PROMPT_FILES[agent_config.type]
            prompt_content = await evolve.execute_command(
                f'cat /home/user/workspace/{prompt_file}'
            )

            assert_true(
                custom_prompt in prompt_content.stdout,
                'Should include custom prompt'
            )
            # SWE mode uses workspace-swe.md template which includes directory structure with repo/
            assert_true(
                'Directory structure:' in prompt_content.stdout,
                'Should include SWE workspace structure instructions'
            )
            assert_true(
                'repo/' in prompt_content.stdout,
                'SWE mode should include repo/ folder in directory structure'
            )

            log_result(True, 'SWE mode uses workspace template + custom prompt')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_context_in_knowledge_mode():
    """Test 5: Knowledge mode - context files"""
    log_section(f"Test 5: Knowledge mode - context files - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        context={
            'readme.txt': 'This is a readme file',
            'data.json': '{"key": "value"}',
        },
    ) as evolve:
        try:
            log_info('Initializing with relative context file paths')

            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # Verify files were created in context/ directory
            result = await evolve.execute_command('ls -la /home/user/workspace/context/')

            assert_true('readme.txt' in result.stdout, 'readme.txt should be in context/')
            assert_true('data.json' in result.stdout, 'data.json should be in context/')

            # Verify content
            readme_content = await evolve.execute_command(
                'cat /home/user/workspace/context/readme.txt'
            )
            assert_true(
                'This is a readme file' in readme_content.stdout,
                'readme.txt content should match'
            )

            log_result(True, 'Context files uploaded to context/ directory')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_context_in_swe_mode():
    """Test 6: SWE mode - context files work normally"""
    log_section(f"Test 6: SWE mode - context files work normally - {agent_name}")

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='swe',
        context={
            'config.yaml': 'version: 1.0',
        },
    ) as evolve:
        try:
            log_info('Initializing SWE mode with context files')

            await evolve.run(
                prompt='Create a hello.txt file inside the output/ folder with content "Hello world!"',
                timeout_ms=120000,
            )

            # In SWE mode, context files still get uploaded (context/ created on-demand)
            result = await evolve.execute_command(
                'cat /home/user/workspace/context/config.yaml'
            )

            assert_true(
                result.exit_code == 0 and 'version: 1.0' in result.stdout,
                'Context files should work in SWE mode'
            )

            log_result(True, 'Context files uploaded successfully in SWE mode')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def run_all_tests():
    """Run all workspace mode tests"""
    print('\n🚀 Starting Workspace Mode Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}\n')

    try:
        await test_knowledge_mode_structure()
        await test_knowledge_mode_with_custom_prompt()
        await test_swe_mode_structure()
        await test_swe_mode_with_custom_prompt()
        await test_context_in_knowledge_mode()
        await test_context_in_swe_mode()

        print('\n' + '=' * 70)
        print(f'✅ All workspace mode tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
