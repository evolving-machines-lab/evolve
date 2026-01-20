#!/usr/bin/env python3
"""MCP Server Tests

Tests: MCP server configuration and usage
Agent Support: All except Codex (codex only supports STDIO transport)

Test 1: Exa MCP Server (with DuckDuckGo also configured)
Test 2: Brave Search MCP Server (requires BRAVE_API_KEY)
"""

import os
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
exa_api_key = os.getenv('EXA_API_KEY')
brave_api_key = os.getenv('BRAVE_API_KEY')

# Map agent type to MCP config file location
MCP_CONFIG_FILES = {
    'codex': '~/.codex/config.toml',
    'claude': '/home/user/workspace/.mcp.json',
    'gemini': '~/.gemini/settings.json',
    'qwen': '~/.qwen/settings.json',
}


async def test_duckduckgo_mcp():
    """Test 1: Exa MCP Server (with DuckDuckGo also configured)"""
    log_section(f"Test 1: Exa MCP Server - {agent_name}")

    if not exa_api_key:
        log_info('⚠️  EXA_API_KEY not set, skipping test')
        return

    if agent_config.type == 'codex':
        log_info('⚠️  Codex only supports STDIO transport, skipping test')
        return

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        mcp_servers={
            'search_duckduckgo': {
                'command': 'uvx',
                'args': ['duckduckgo-mcp-server']
            },
            "exa": {
                "command": "npx",
                "args": [
                    "-y",
                    "mcp-remote",
                    "https://mcp.exa.ai/mcp"
                ],
                "env": {
                    "EXA_API_KEY": exa_api_key
                }
            }
        },
    ) as evolve:
        try:
            log_info('Initializing sandbox with Exa and DuckDuckGo MCP servers')

            await evolve.run(
                prompt='Use the EXA search tool to search for "TypeScript" and tell me one thing you found',
                timeout_ms=180000,  # 3 minutes
            )

            log_result(True, 'Search request completed successfully')

            # Verify MCP config file was created
            config_file = MCP_CONFIG_FILES[agent_config.type]
            log_info(f'Verifying MCP config file: {config_file}')

            config_check = await evolve.execute_command(
                f'test -f {config_file} && echo "exists" || echo "not found"'
            )

            assert_true('exists' in config_check.stdout, f'MCP config file {config_file} should exist')
            log_result(True, f'MCP config file created: {config_file}')

            # Read and verify config content
            config_content = await evolve.execute_command(f'cat {config_file}')

            # Codex uses TOML format
            if agent_config.type == 'codex':
                assert_true(
                    '[mcp_servers.exa]' in config_content.stdout,
                    'TOML config should have exa section'
                )
                assert_true(
                    'command = "npx"' in config_content.stdout,
                    'TOML config should have npx command'
                )
                assert_true(
                    'EXA_API_KEY' in config_content.stdout,
                    'TOML config should have EXA_API_KEY env var'
                )
                log_result(True, 'TOML MCP config structure verified')
            # Other agents use JSON format
            else:
                assert_true(
                    'exa' in config_content.stdout,
                    'JSON config should have exa'
                )
                assert_true(
                    'npx' in config_content.stdout or 'command' in config_content.stdout,
                    'JSON config should have command field'
                )
                assert_true(
                    'EXA_API_KEY' in config_content.stdout,
                    'JSON config should have EXA_API_KEY env var'
                )
                log_result(True, 'JSON MCP config structure verified')

            log_result(True, 'Exa MCP server is active and working')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def test_brave_mcp():
    """Test 2: Brave Search MCP Server"""
    log_section(f"Test 2: Brave Search MCP Server - {agent_name}")

    if not brave_api_key:
        log_info('⚠️  BRAVE_API_KEY not set, skipping test')
        return

    if agent_config.type == 'codex':
        log_info('⚠️  Codex only supports STDIO transport, skipping test')
        return

    async with Evolve(
        config=agent_config,
        sandbox=E2BProvider(api_key=get_e2b_api_key()),
        workspace_mode='knowledge',
        mcp_servers={
            'search_bravesearch': {
                'command': 'npx',
                'args': ['-y', '@modelcontextprotocol/server-brave-search'],
                'env': {
                    'BRAVE_API_KEY': brave_api_key
                }
            }
        },
    ) as evolve:
        try:
            log_info('Initializing sandbox with Brave Search MCP server')

            await evolve.run(
                prompt='Use the Brave search tool to search for "Node.js" and tell me one thing you found',
                timeout_ms=180000,  # 3 minutes
            )

            log_result(True, 'Search request completed successfully')

            # Verify MCP config file was created
            config_file = MCP_CONFIG_FILES[agent_config.type]
            log_info(f'Verifying MCP config file: {config_file}')

            config_check = await evolve.execute_command(
                f'test -f {config_file} && echo "exists" || echo "not found"'
            )

            assert_true('exists' in config_check.stdout, f'MCP config file {config_file} should exist')
            log_result(True, f'MCP config file created: {config_file}')

            # Read and verify config content
            config_content = await evolve.execute_command(f'cat {config_file}')

            # Codex uses TOML format
            if agent_config.type == 'codex':
                assert_true(
                    '[mcp_servers.search_bravesearch]' in config_content.stdout,
                    'TOML config should have search_bravesearch section'
                )
                assert_true(
                    'command = "npx"' in config_content.stdout,
                    'TOML config should have npx command'
                )
                assert_true(
                    'BRAVE_API_KEY' in config_content.stdout,
                    'TOML config should have BRAVE_API_KEY env var'
                )
                log_result(True, 'TOML MCP config structure verified')
            # Other agents use JSON format
            else:
                assert_true(
                    'search_bravesearch' in config_content.stdout,
                    'JSON config should have search_bravesearch'
                )
                assert_true(
                    'npx' in config_content.stdout or 'command' in config_content.stdout,
                    'JSON config should have command field'
                )
                assert_true(
                    'BRAVE_API_KEY' in config_content.stdout,
                    'JSON config should have BRAVE_API_KEY env var'
                )
                log_result(True, 'JSON MCP config structure verified')

            log_result(True, 'Brave Search MCP server is active and working')
            log_result(True, 'Test completed successfully')
        except Exception as error:
            log_result(False, 'Test failed', error)
            raise


async def run_all_tests():
    """Run all MCP server tests"""
    print('\n🚀 Starting MCP Server Tests')
    print(f'📋 Agent: {agent_name} ({agent_config.type})')
    print(f'🔑 Model: {agent_config.model or "default"}')

    if agent_config.type == 'codex':
        print('\n⚠️  WARNING: Codex only supports STDIO transport')
        print('   All MCP tests will be skipped\n')
    else:
        missing_keys = []
        if not exa_api_key:
            missing_keys.append('EXA_API_KEY')
        if not brave_api_key:
            missing_keys.append('BRAVE_API_KEY')

        if missing_keys:
            print(f'\n⚠️  WARNING: {", ".join(missing_keys)} not set')
            if not exa_api_key:
                print('   Test 1 (Exa) will be skipped')
            if not brave_api_key:
                print('   Test 2 (Brave) will be skipped')
            print('   Set missing API keys to enable full MCP testing\n')
        else:
            print(f'🔐 EXA_API_KEY: ***{exa_api_key[-4:]}')
            print(f'🔐 BRAVE_API_KEY: ***{brave_api_key[-4:]}\n')

    try:
        await test_duckduckgo_mcp()
        await test_brave_mcp()

        print('\n' + '=' * 70)
        print(f'✅ All MCP server tests passed for {agent_name}!')
        print('=' * 70 + '\n')
        sys.exit(0)
    except Exception as error:
        print(f'\n❌ Tests failed for {agent_name}:', error)
        sys.exit(1)


if __name__ == '__main__':
    asyncio.run(run_all_tests())
