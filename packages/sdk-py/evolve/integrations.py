"""Managed integrations async helpers."""

from dataclasses import dataclass
from typing import Dict, List, Optional

from .bridge import BridgeManager


@dataclass
class IntegrationAuthResult:
    """Result from an integration auth request."""
    url: str
    account_id: Optional[str] = None


@dataclass
class IntegrationAccount:
    """Connected account for a managed app integration."""
    user_id: str
    app: str
    status: str
    app_name: Optional[str] = None
    app_icon: Optional[str] = None
    account_label: Optional[str] = None
    account_id: Optional[str] = None


@dataclass
class IntegrationAccountUpdateResult:
    """Result from updating a connected account."""
    success: bool
    account_id: str
    account_label: Optional[str] = None


@dataclass
class IntegrationAccountDeleteResult:
    """Result from deleting a connected account."""
    success: bool
    account_id: str


async def auth(
    *,
    user_id: str,
    app: str,
    account_label: Optional[str] = None,
    api_key: Optional[str] = None,
    dashboard_url: Optional[str] = None,
) -> IntegrationAuthResult:
    """Create an auth URL for one app account."""
    bridge = BridgeManager()
    try:
        await bridge.start()
        params: Dict[str, object] = {'user_id': user_id, 'app': app}
        if account_label is not None:
            params['account_label'] = account_label
        if api_key:
            params['api_key'] = api_key
        if dashboard_url:
            params['dashboard_url'] = dashboard_url
        response = await bridge.call('integrations_auth', params)
        return IntegrationAuthResult(
            url=response['url'],
            account_id=response.get('account_id'),
        )
    finally:
        await bridge.stop()


class _Accounts:
    async def list(
        self,
        *,
        user_ids: List[str],
        app: Optional[str] = None,
        statuses: Optional[List[str]] = None,
        api_key: Optional[str] = None,
        dashboard_url: Optional[str] = None,
    ) -> List[IntegrationAccount]:
        """List connected accounts for one or more integration users."""
        bridge = BridgeManager()
        try:
            await bridge.start()
            params: Dict[str, object] = {'user_ids': user_ids}
            if app:
                params['app'] = app
            if statuses:
                params['statuses'] = statuses
            if api_key:
                params['api_key'] = api_key
            if dashboard_url:
                params['dashboard_url'] = dashboard_url
            response = await bridge.call('integrations_accounts_list', params)
            return [
                IntegrationAccount(
                    user_id=account['user_id'],
                    app=account['app'],
                    status=account['status'],
                    app_name=account.get('app_name'),
                    app_icon=account.get('app_icon'),
                    account_label=account.get('account_label'),
                    account_id=account.get('account_id'),
                )
                for account in response['accounts']
            ]
        finally:
            await bridge.stop()

    async def update(
        self,
        *,
        account_id: str,
        account_label: Optional[str] = None,
        api_key: Optional[str] = None,
        dashboard_url: Optional[str] = None,
    ) -> IntegrationAccountUpdateResult:
        """Set, update, or clear a connected account label."""
        bridge = BridgeManager()
        try:
            await bridge.start()
            params: Dict[str, object] = {'account_id': account_id}
            if account_label is not None:
                params['account_label'] = account_label
            if api_key:
                params['api_key'] = api_key
            if dashboard_url:
                params['dashboard_url'] = dashboard_url
            response = await bridge.call('integrations_account_update', params)
            return IntegrationAccountUpdateResult(
                success=response['success'],
                account_id=response['account_id'],
                account_label=response.get('account_label'),
            )
        finally:
            await bridge.stop()

    async def delete(
        self,
        *,
        account_id: str,
        api_key: Optional[str] = None,
        dashboard_url: Optional[str] = None,
    ) -> IntegrationAccountDeleteResult:
        """Delete a connected account."""
        bridge = BridgeManager()
        try:
            await bridge.start()
            params: Dict[str, object] = {'account_id': account_id}
            if api_key:
                params['api_key'] = api_key
            if dashboard_url:
                params['dashboard_url'] = dashboard_url
            response = await bridge.call('integrations_account_delete', params)
            return IntegrationAccountDeleteResult(
                success=response['success'],
                account_id=response['account_id'],
            )
        finally:
            await bridge.stop()


accounts = _Accounts()


__all__ = [
    'auth',
    'accounts',
    'IntegrationAuthResult',
    'IntegrationAccount',
    'IntegrationAccountUpdateResult',
    'IntegrationAccountDeleteResult',
]
