#!/usr/bin/env python3
"""BYOK Direct Mode Integration Test

Tests direct mode (Bring Your Own Key) with provider API keys.
Uses provider_api_key instead of api_key to bypass the Evolve gateway.

Required env vars (in .env):
  ANTHROPIC_API_KEY - For Claude direct mode
  OPENAI_API_KEY - For Codex direct mode
  GEMINI_API_KEY - For Gemini direct mode
  DASHSCOPE_API_KEY - For Qwen direct mode (Alibaba)
  E2B_API_KEY - For E2B sandbox direct mode

Usage:
  python -m tests.integration.test_14_byok_direct_mode           # all agents
  python -m tests.integration.test_14_byok_direct_mode claude    # single agent
  python -m tests.integration.test_14_byok_direct_mode claude codex  # multiple
"""

import os
import sys
import asyncio
import shutil
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
from evolve import Evolve, AgentConfig, E2BProvider

# Load .env from workspace root
root_dir = Path(__file__).parent.parent.parent.parent.parent
env_file = root_dir / '.env'
if env_file.exists():
    load_dotenv(env_file)

# Logs directory
LOGS_DIR = Path(__file__).parent.parent / 'test-logs' / '14-byok-direct-mode'


# =============================================================================
# CONFIG
# =============================================================================

ALL_AGENTS = ['claude', 'codex', 'gemini', 'qwen']


def save_log(agent: str, name: str, content: str | bytes) -> None:
    """Save log file for an agent."""
    agent_dir = LOGS_DIR / agent
    agent_dir.mkdir(parents=True, exist_ok=True)
    mode = 'wb' if isinstance(content, bytes) else 'w'
    with open(agent_dir / name, mode) as f:
        f.write(content)


def save_output_files(agent: str, prefix: str, files: dict) -> None:
    """Save output files for an agent."""
    output_dir = LOGS_DIR / agent / prefix
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        file_path = output_dir / Path(name).name
        mode = 'wb' if isinstance(content, bytes) else 'w'
        with open(file_path, mode) as f:
            f.write(content)


def get_provider_env() -> dict:
    """Get provider API keys from environment."""
    return {
        'ANTHROPIC_API_KEY': os.getenv('ANTHROPIC_API_KEY'),
        'OPENAI_API_KEY': os.getenv('OPENAI_API_KEY'),
        'GEMINI_API_KEY': os.getenv('GEMINI_API_KEY'),
        'DASHSCOPE_API_KEY': os.getenv('DASHSCOPE_API_KEY'),
        'E2B_API_KEY': os.getenv('E2B_API_KEY'),
    }


def get_byok_agent_config(agent_type: str) -> Optional[AgentConfig]:
    """Get BYOK agent config using provider API keys directly.

    This bypasses the Evolve gateway for direct provider access.

    Args:
        agent_type: Agent type (claude, codex, gemini, qwen)

    Returns:
        AgentConfig with provider_api_key, or None if key not available
    """
    env = get_provider_env()

    if agent_type == 'claude':
        if not env['ANTHROPIC_API_KEY']:
            return None
        return AgentConfig(
            type='claude',
            provider_api_key=env['ANTHROPIC_API_KEY'],
            model=os.getenv('ANTHROPIC_MODEL', 'sonnet'),
        )

    elif agent_type == 'codex':
        if not env['OPENAI_API_KEY']:
            return None
        return AgentConfig(
            type='codex',
            provider_api_key=env['OPENAI_API_KEY'],
            model=os.getenv('CODEX_MODEL', 'gpt-5.2'),
            reasoning_effort=os.getenv('CODEX_REASONING_EFFORT', 'medium'),
        )

    elif agent_type == 'gemini':
        if not env['GEMINI_API_KEY']:
            return None
        return AgentConfig(
            type='gemini',
            provider_api_key=env['GEMINI_API_KEY'],
            model=os.getenv('GEMINI_MODEL', 'gemini-3-flash-preview'),
        )

    elif agent_type == 'qwen':
        # Qwen uses DASHSCOPE_API_KEY
        # The provider_base_url is auto-resolved from registry (Dashscope endpoint)
        if not env['DASHSCOPE_API_KEY']:
            return None
        return AgentConfig(
            type='qwen',
            provider_api_key=env['DASHSCOPE_API_KEY'],
            model=os.getenv('QWEN_OPENAI_MODEL', 'qwen3-coder-plus'),
        )

    return None


# =============================================================================
# TEST
# =============================================================================

async def test_agent(agent_type: str) -> dict:
    """Test a single agent with BYOK direct mode.

    Args:
        agent_type: Agent type to test

    Returns:
        dict with ok, error, skipped, duration
    """
    import time
    start = time.time()
    env = get_provider_env()

    # Check if E2B key is available
    if not env['E2B_API_KEY']:
        return {'ok': False, 'error': 'E2B_API_KEY not set', 'skipped': True, 'duration': 0}

    # Get BYOK config for this agent
    agent_config = get_byok_agent_config(agent_type)
    if not agent_config:
        key_name = {
            'claude': 'ANTHROPIC_API_KEY',
            'codex': 'OPENAI_API_KEY',
            'gemini': 'GEMINI_API_KEY',
            'qwen': 'DASHSCOPE_API_KEY',
        }.get(agent_type, 'UNKNOWN_KEY')
        return {'ok': False, 'error': f'{key_name} not set', 'skipped': True, 'duration': 0}

    print(f'[{agent_type}] Using BYOK direct mode with provider key')
    print(f'[{agent_type}] Model: {agent_config.model}')

    try:
        # Build Evolve instance with BYOK (provider_api_key instead of api_key)
        async with Evolve(
            config=agent_config,
            sandbox=E2BProvider(api_key=env['E2B_API_KEY']),
            system_prompt='You are a helpful assistant. Be concise.',
        ) as evolve:
            print(f'[{agent_type}] Running BYOK test...')

            result = await evolve.run(
                prompt=f'Create a file called byok_test_{agent_type}.txt with the content "BYOK direct mode works for {agent_type}!"',
                timeout_ms=120000,
            )

            # Save logs
            save_log(agent_type, 'stdout.txt', result.stdout)
            save_log(agent_type, 'stderr.txt', result.stderr)

            output = await evolve.get_output_files()
            save_output_files(agent_type, 'output', output.files)

            print(f'[{agent_type}] Done (exit={result.exit_code}, outputs={len(output.files)})')

            # Verify the file was created
            expected_file = f'byok_test_{agent_type}.txt'
            has_file = any(expected_file in f for f in output.files.keys())

            if not has_file:
                print(f'[{agent_type}] Warning: Expected file {expected_file} not found in outputs')

            duration = time.time() - start
            return {'ok': result.exit_code == 0, 'duration': duration}

    except Exception as e:
        duration = time.time() - start
        save_log(agent_type, 'error.txt', str(e))
        return {'ok': False, 'error': str(e), 'duration': duration}


async def main():
    """Run BYOK tests for specified agents."""
    # Parse command line args
    args = sys.argv[1:]
    agents = args if args else ALL_AGENTS

    # Clean and create logs directory
    if LOGS_DIR.exists():
        shutil.rmtree(LOGS_DIR)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    print('=' * 60)
    print('BYOK Direct Mode Integration Test (Python)')
    print('Using provider API keys (bypassing Evolve gateway)')
    print('=' * 60)
    print(f'\nTesting: {", ".join(agents)}\n')

    # Check which keys are available
    env = get_provider_env()
    print('Provider keys status:')
    print(f'  ANTHROPIC_API_KEY: {"✓ set" if env["ANTHROPIC_API_KEY"] else "✗ not set"}')
    print(f'  OPENAI_API_KEY: {"✓ set" if env["OPENAI_API_KEY"] else "✗ not set"}')
    print(f'  GEMINI_API_KEY: {"✓ set" if env["GEMINI_API_KEY"] else "✗ not set"}')
    print(f'  DASHSCOPE_API_KEY: {"✓ set" if env["DASHSCOPE_API_KEY"] else "✗ not set"}')
    print(f'  E2B_API_KEY: {"✓ set" if env["E2B_API_KEY"] else "✗ not set"}')
    print()

    # Run tests in parallel
    results = await asyncio.gather(*[test_agent(agent) for agent in agents])

    print('\n' + '=' * 60)
    print('Results:')
    print('=' * 60)

    passed = 0
    skipped = 0
    for i, agent in enumerate(agents):
        result = results[i]
        if result.get('skipped'):
            print(f'⊘ SKIP {agent} - {result.get("error")}')
            skipped += 1
        elif result['ok']:
            print(f'✓ PASS {agent} ({result["duration"]:.1f}s)')
            passed += 1
        else:
            print(f'✗ FAIL {agent} ({result["duration"]:.1f}s) - {result.get("error")}')

    print('=' * 60)
    print(f'{passed}/{len(agents) - skipped} passed, {skipped} skipped\n')

    # Exit with success if all non-skipped tests passed
    failed = len(agents) - skipped - passed
    sys.exit(1 if failed > 0 else 0)


if __name__ == '__main__':
    asyncio.run(main())
