"""Test helpers and utilities."""

import os
import json
import asyncio
from typing import Any, Optional
from pathlib import Path
from dotenv import load_dotenv

# Load .env from workspace root
root_dir = Path(__file__).parent.parent.parent.parent.parent
env_file = root_dir / '.env'
if env_file.exists():
    load_dotenv(env_file)


def get_e2b_api_key() -> str:
    """Get E2B API key from environment.

    Returns:
        str: E2B API key

    Raises:
        ValueError: If E2B_API_KEY not found in environment
    """
    api_key = os.getenv('E2B_API_KEY')
    if not api_key:
        raise ValueError('E2B_API_KEY not found in environment variables')
    return api_key


def log_section(title: str) -> None:
    """Log test section header.

    Args:
        title: Section title
    """
    print('\n' + '=' * 70)
    print(f'🧪 {title}')
    print('=' * 70 + '\n')


def log_result(success: bool, message: str, details: Any = None) -> None:
    """Log test result.

    Args:
        success: Whether the test passed
        message: Result message
        details: Optional details (string or object)
    """
    icon = '✅' if success else '❌'
    print(f'{icon} {message}')
    if details:
        if isinstance(details, str):
            print(f'   {details}')
        else:
            print(f'   {json.dumps(details, indent=2) if not isinstance(details, Exception) else str(details)}')


def log_info(message: str) -> None:
    """Log info message.

    Args:
        message: Info message
    """
    print(f'ℹ️  {message}')


def assert_true(condition: bool, message: str) -> None:
    """Assert condition and raise if false.

    Args:
        condition: Condition to check
        message: Error message

    Raises:
        AssertionError: If condition is False
    """
    if not condition:
        raise AssertionError(f'Assertion failed: {message}')


async def sleep(ms: int) -> None:
    """Sleep for specified milliseconds.

    Args:
        ms: Milliseconds to sleep
    """
    await asyncio.sleep(ms / 1000.0)


def try_parse_json(text: str) -> Optional[Any]:
    """Safely parse JSON, return None if invalid.

    Args:
        text: JSON string to parse

    Returns:
        Parsed JSON object or None if invalid
    """
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def contains_any(text: str, substrings: list[str]) -> bool:
    """Check if a string contains any of the given substrings.

    Args:
        text: Text to search in
        substrings: Substrings to search for

    Returns:
        bool: True if any substring is found
    """
    return any(substr.lower() in text.lower() for substr in substrings)


def extract_sandbox_id(message: str) -> Optional[str]:
    """Extract sandbox ID from JSON update message.

    Args:
        message: JSON message string

    Returns:
        Sandbox ID or None if not found
    """
    parsed = try_parse_json(message)
    if parsed and 'sandbox_id' in parsed:
        return parsed['sandbox_id']
    return None


async def wait_for(
    condition: callable,
    timeout_ms: int = 10000,
    check_interval_ms: int = 100
) -> None:
    """Wait for a condition to be true with timeout.

    Args:
        condition: Function that returns bool
        timeout_ms: Timeout in milliseconds
        check_interval_ms: Check interval in milliseconds

    Raises:
        TimeoutError: If condition not met within timeout
    """
    start_time = asyncio.get_event_loop().time()
    while not condition():
        if (asyncio.get_event_loop().time() - start_time) * 1000 > timeout_ms:
            raise TimeoutError('Timeout waiting for condition')
        await sleep(check_interval_ms)
