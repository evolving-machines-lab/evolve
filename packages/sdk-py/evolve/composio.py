"""Composio Tool Router async helpers.

Static helpers for Composio pre-authentication flows.
These run independently of Evolve instances - use them before creating an agent.

Example:
    >>> from evolve import Evolve, ComposioSetup
    >>>
    >>> # Get OAuth URL for GitHub authentication
    >>> result = await Evolve.composio.auth('user-123', 'github')
    >>> print(f'Please authenticate at: {result.url}')
    >>>
    >>> # Check if user is connected
    >>> connected = await Evolve.composio.status('user-123', 'github')
    >>> if connected:
    ...     # Ready to use Composio tools
    ...     async with Evolve(composio=ComposioSetup(user_id='user-123')) as kit:
    ...         await kit.run('Star the repo anthropics/claude-code on GitHub')
"""

from dataclasses import dataclass
from typing import Dict, List, Optional, Union

from .bridge import BridgeManager


@dataclass
class ComposioAuthResult:
    """Result from composio auth request."""
    url: str
    connection_id: str


@dataclass
class ComposioConnectionStatus:
    """Connection status for a toolkit."""
    toolkit: str
    connected: bool
    account_id: Optional[str] = None


async def auth(user_id: str, toolkit: str) -> ComposioAuthResult:
    """Get OAuth URL for authenticating a toolkit.

    Args:
        user_id: User's unique identifier for Composio session
        toolkit: Toolkit to authenticate (e.g., 'github', 'gmail', 'slack')

    Returns:
        ComposioAuthResult with OAuth URL to redirect user to

    Example:
        >>> result = await Evolve.composio.auth('user-123', 'github')
        >>> print(f'Authenticate at: {result.url}')
    """
    bridge = BridgeManager()
    try:
        await bridge.start()
        response = await bridge.call('composio_auth', {
            'user_id': user_id,
            'toolkit': toolkit,
        })
        return ComposioAuthResult(
            url=response['url'],
            connection_id=response['connection_id'],
        )
    finally:
        await bridge.stop()


async def status(user_id: str, toolkit: Optional[str] = None) -> Union[bool, Dict[str, bool]]:
    """Check connection status for a user.

    Args:
        user_id: User's unique identifier for Composio session
        toolkit: Optional specific toolkit to check (if None, checks all)

    Returns:
        bool if toolkit specified, Dict[str, bool] if not

    Example:
        >>> # Check specific toolkit
        >>> connected = await Evolve.composio.status('user-123', 'github')
        >>> print(f'GitHub connected: {connected}')
        >>>
        >>> # Check all toolkits
        >>> statuses = await Evolve.composio.status('user-123')
        >>> for tk, connected in statuses.items():
        ...     print(f'{tk}: {"connected" if connected else "not connected"}')
    """
    bridge = BridgeManager()
    try:
        await bridge.start()
        params = {'user_id': user_id}
        if toolkit:
            params['toolkit'] = toolkit
        response = await bridge.call('composio_status', params)
        if 'connected' in response:
            return response['connected']
        return response['status_map']
    finally:
        await bridge.stop()


async def connections(user_id: str) -> List[ComposioConnectionStatus]:
    """List all connections for a user.

    Args:
        user_id: User's unique identifier for Composio session

    Returns:
        List of ComposioConnectionStatus

    Example:
        >>> conns = await Evolve.composio.connections('user-123')
        >>> for conn in conns:
        ...     status = 'connected' if conn.connected else 'disconnected'
        ...     print(f'{conn.toolkit}: {status}')
    """
    bridge = BridgeManager()
    try:
        await bridge.start()
        response = await bridge.call('composio_connections', {'user_id': user_id})
        return [
            ComposioConnectionStatus(
                toolkit=c['toolkit'],
                connected=c['connected'],
                account_id=c.get('account_id'),
            )
            for c in response['connections']
        ]
    finally:
        await bridge.stop()


__all__ = [
    'auth',
    'status',
    'connections',
    'ComposioAuthResult',
    'ComposioConnectionStatus',
]
