#!/usr/bin/env python3
"""OAuth Mode Integration Test (Claude Max Subscription)

Tests OAuth direct mode using CLAUDE_CODE_OAUTH_TOKEN.
This allows Claude Max subscribers to use their subscription credits.

Required env vars (in .env):
  CLAUDE_CODE_OAUTH_TOKEN - OAuth token from Claude Max subscription
  E2B_API_KEY - For E2B sandbox

Usage:
  python -m tests.integration.test_15_oauth_mode
"""

import os
import sys
import asyncio
import shutil
from pathlib import Path
from dotenv import load_dotenv
from evolve import Evolve, AgentConfig, E2BProvider

# Load .env from workspace root
root_dir = Path(__file__).parent.parent.parent.parent.parent
env_file = root_dir / '.env'
if env_file.exists():
    load_dotenv(env_file)

# Logs directory
LOGS_DIR = Path(__file__).parent.parent / 'test-logs' / '15-oauth-mode'


# =============================================================================
# HELPERS
# =============================================================================

def save_log(name: str, content: str | bytes) -> None:
    """Save log file."""
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    mode = 'wb' if isinstance(content, bytes) else 'w'
    with open(LOGS_DIR / name, mode) as f:
        f.write(content)


def save_output_files(prefix: str, files: dict) -> None:
    """Save output files."""
    output_dir = LOGS_DIR / prefix
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        file_path = output_dir / Path(name).name
        mode = 'wb' if isinstance(content, bytes) else 'w'
        with open(file_path, mode) as f:
            f.write(content)


def get_env() -> dict:
    """Get required environment variables."""
    return {
        'CLAUDE_CODE_OAUTH_TOKEN': os.getenv('CLAUDE_CODE_OAUTH_TOKEN'),
        'E2B_API_KEY': os.getenv('E2B_API_KEY'),
    }


# =============================================================================
# TEST
# =============================================================================

async def test_oauth() -> dict:
    """Test OAuth mode with Claude Max subscription.

    Returns:
        dict with ok, error, duration
    """
    import time
    start = time.time()
    env = get_env()

    # Check required env vars
    if not env['CLAUDE_CODE_OAUTH_TOKEN']:
        return {'ok': False, 'error': 'CLAUDE_CODE_OAUTH_TOKEN not set', 'duration': 0}
    if not env['E2B_API_KEY']:
        return {'ok': False, 'error': 'E2B_API_KEY not set', 'duration': 0}

    print('[claude] Using OAuth mode (Claude Max subscription)')
    print('[claude] Model: sonnet')

    try:
        # Build Evolve with explicit oauth_token
        async with Evolve(
            config=AgentConfig(
                type='claude',
                oauth_token=env['CLAUDE_CODE_OAUTH_TOKEN'],
                model='sonnet',
            ),
            sandbox=E2BProvider(api_key=env['E2B_API_KEY']),
            system_prompt='You are a helpful assistant. Be concise.',
        ) as evolve:
            print('[claude] Running OAuth test...')

            result = await evolve.run(
                prompt='Create a file called oauth_test.txt with the content "OAuth mode works!"',
                timeout_ms=120000,
            )

            # Save logs
            save_log('stdout.txt', result.stdout)
            save_log('stderr.txt', result.stderr)

            output = await evolve.get_output_files()
            save_output_files('output', output.files)

            print(f'[claude] Done (exit={result.exit_code}, outputs={len(output.files)})')

            # Verify the file was created
            has_file = any('oauth_test.txt' in f for f in output.files.keys())
            if not has_file:
                print('[claude] Warning: Expected file oauth_test.txt not found in outputs')

            duration = time.time() - start
            return {'ok': result.exit_code == 0, 'duration': duration}

    except Exception as e:
        duration = time.time() - start
        save_log('error.txt', str(e))
        return {'ok': False, 'error': str(e), 'duration': duration}


# =============================================================================
# MAIN
# =============================================================================

async def main():
    """Run OAuth mode test."""
    # Clean and create logs directory
    if LOGS_DIR.exists():
        shutil.rmtree(LOGS_DIR)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    print('=' * 60)
    print('OAuth Mode Integration Test (Claude Max Subscription)')
    print('=' * 60)

    env = get_env()
    print('\nEnv status:')
    print(f'  CLAUDE_CODE_OAUTH_TOKEN: {"✓ set" if env["CLAUDE_CODE_OAUTH_TOKEN"] else "✗ not set"}')
    print(f'  E2B_API_KEY: {"✓ set" if env["E2B_API_KEY"] else "✗ not set"}')
    print()

    result = await test_oauth()

    print('\n' + '=' * 60)
    print('Result:')
    print('=' * 60)

    if result['ok']:
        print(f'✓ PASS claude oauth ({result["duration"]:.1f}s)')
    else:
        print(f'✗ FAIL claude oauth - {result.get("error")}')

    print('=' * 60 + '\n')
    sys.exit(0 if result['ok'] else 1)


if __name__ == '__main__':
    asyncio.run(main())
