"""Test helpers and utilities."""

import os
import json
import asyncio
from typing import Any, Optional, Literal, List
from pathlib import Path
from dotenv import load_dotenv
from evolve import E2BProvider, DaytonaProvider, ModalProvider, SandboxProvider

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


ProviderName = Literal['e2b', 'daytona', 'modal']


def get_available_providers() -> List[ProviderName]:
    """Get available sandbox providers based on environment variables."""
    available: List[ProviderName] = []
    if os.getenv('E2B_API_KEY'):
        available.append('e2b')
    if os.getenv('DAYTONA_API_KEY'):
        available.append('daytona')
    if os.getenv('MODAL_TOKEN_ID') and os.getenv('MODAL_TOKEN_SECRET'):
        available.append('modal')
    return available


def create_sandbox_provider(provider: ProviderName) -> SandboxProvider:
    """Create sandbox provider from env-based configuration."""
    if provider == 'e2b':
        return E2BProvider(api_key=get_e2b_api_key())

    if provider == 'daytona':
        api_key = os.getenv('DAYTONA_API_KEY')
        if not api_key:
            raise ValueError('DAYTONA_API_KEY not found in environment variables')
        return DaytonaProvider(
            api_key=api_key,
            api_url=os.getenv('DAYTONA_API_URL'),
            target=os.getenv('DAYTONA_TARGET'),
        )

    if provider == 'modal':
        token_id = os.getenv('MODAL_TOKEN_ID')
        token_secret = os.getenv('MODAL_TOKEN_SECRET')
        if not token_id or not token_secret:
            raise ValueError('MODAL_TOKEN_ID and MODAL_TOKEN_SECRET required for modal provider')
        return ModalProvider(
            token_id=token_id,
            token_secret=token_secret,
            endpoint=os.getenv('MODAL_ENDPOINT'),
            app_name=os.getenv('MODAL_APP_NAME'),
        )

    raise ValueError(f'Unsupported provider: {provider}')


def supports_pause_resume(provider: ProviderName) -> bool:
    """Whether provider supports pause/resume."""
    return provider != 'modal'


def supports_interrupt(provider: ProviderName) -> bool:
    """Whether provider supports interrupt for active process."""
    return provider != 'modal'


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
