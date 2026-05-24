"""Managed integrations async helpers."""

from dataclasses import dataclass
from typing import Dict, List, Optional

from .bridge import BridgeManager


@dataclass
class IntegrationConnectResult:
    """Result from an integration connect request."""
    url: str
    connection_id: Optional[str] = None


@dataclass
class IntegrationConnectionStatus:
    """Connection status for an app."""
    app: str
    status: str
    app_name: Optional[str] = None
    app_icon: Optional[str] = None
    account_id: Optional[str] = None


@dataclass
class IntegrationActivity:
    """Recent tool-call activity for an app integration."""
    app: str
    tool: str
    status: str
    user_id: str
    occurred_at: str
    app_name: Optional[str] = None
    duration_ms: Optional[int] = None


async def connect(
    app: str,
    user_id: Optional[str] = None,
    user_token: Optional[str] = None,
    callback_url: Optional[str] = None,
    api_key: Optional[str] = None,
    dashboard_url: Optional[str] = None,
) -> IntegrationConnectResult:
    """Create an auth URL for an app connection."""
    bridge = BridgeManager()
    try:
        await bridge.start()
        params: Dict[str, str] = {'app': app}
        if user_id:
            params['user_id'] = user_id
        if user_token:
            params['user_token'] = user_token
        if callback_url:
            params['callback_url'] = callback_url
        if api_key:
            params['api_key'] = api_key
        if dashboard_url:
            params['dashboard_url'] = dashboard_url
        response = await bridge.call('integrations_connect', params)
        return IntegrationConnectResult(
            url=response['url'],
            connection_id=response.get('connection_id'),
        )
    finally:
        await bridge.stop()


async def status(
    user_id: Optional[str] = None,
    user_token: Optional[str] = None,
    api_key: Optional[str] = None,
    dashboard_url: Optional[str] = None,
) -> List[IntegrationConnectionStatus]:
    """List connection status for an integration user."""
    bridge = BridgeManager()
    try:
        await bridge.start()
        params: Dict[str, str] = {}
        if user_id:
            params['user_id'] = user_id
        if user_token:
            params['user_token'] = user_token
        if api_key:
            params['api_key'] = api_key
        if dashboard_url:
            params['dashboard_url'] = dashboard_url
        response = await bridge.call('integrations_status', params)
        return [
            IntegrationConnectionStatus(
                app=connection['app'],
                status=connection['status'],
                app_name=connection.get('app_name'),
                app_icon=connection.get('app_icon'),
                account_id=connection.get('account_id'),
            )
            for connection in response['connections']
        ]
    finally:
        await bridge.stop()


async def activity(
    user_id: Optional[str] = None,
    user_token: Optional[str] = None,
    api_key: Optional[str] = None,
    dashboard_url: Optional[str] = None,
) -> List[IntegrationActivity]:
    """List recent integration tool-call activity."""
    bridge = BridgeManager()
    try:
        await bridge.start()
        params: Dict[str, str] = {}
        if user_id:
            params['user_id'] = user_id
        if user_token:
            params['user_token'] = user_token
        if api_key:
            params['api_key'] = api_key
        if dashboard_url:
            params['dashboard_url'] = dashboard_url
        response = await bridge.call('integrations_activity', params)
        return [
            IntegrationActivity(
                app=event['app'],
                app_name=event.get('app_name'),
                tool=event['tool'],
                status=event['status'],
                user_id=event['user_id'],
                duration_ms=event.get('duration_ms'),
                occurred_at=event['occurred_at'],
            )
            for event in response['activity']
        ]
    finally:
        await bridge.stop()


__all__ = [
    'connect',
    'status',
    'activity',
    'IntegrationConnectResult',
    'IntegrationConnectionStatus',
    'IntegrationActivity',
]
