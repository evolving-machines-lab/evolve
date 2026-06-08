"""Standalone browser profiles client."""

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .config import BrowserProfilesClientConfig


DEFAULT_DASHBOARD_URL = 'https://dashboard.evolvingmachines.ai'


@dataclass
class BrowserProfileMetadata:
    id: str
    profile: str
    created_at: str
    updated_at: str
    last_used_at: Optional[str]


@dataclass
class BrowserProfilesPage:
    profiles: List[BrowserProfileMetadata]


def _metadata_from_dict(data: Dict[str, Any]) -> BrowserProfileMetadata:
    return BrowserProfileMetadata(
        id=data['id'],
        profile=data['profile'],
        created_at=data.get('createdAt') or data.get('created_at') or '',
        updated_at=data.get('updatedAt') or data.get('updated_at') or '',
        last_used_at=data.get('lastUsedAt') or data.get('last_used_at'),
    )


class BrowserProfilesClient:
    """List and delete reusable browser profiles."""

    def __init__(
        self,
        config: Optional[BrowserProfilesClientConfig] = None,
    ):
        self.config = config or BrowserProfilesClientConfig()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def close(self):
        return None

    async def list(self) -> BrowserProfilesPage:
        result = await self._request_json('/api/browser-profiles')
        return BrowserProfilesPage(
            profiles=[_metadata_from_dict(item) for item in result.get('profiles', [])],
        )

    async def delete(
        self,
        *,
        profile: str,
    ) -> Dict[str, bool]:
        body: Dict[str, Any] = {'profile': profile}
        return await self._request_json('/api/browser-profiles', method='DELETE', body=body)

    async def _request_json(
        self,
        path: str,
        method: str = 'GET',
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await asyncio.to_thread(self._request_json_sync, path, method, body)

    def _request_json_sync(
        self,
        path: str,
        method: str,
        body: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        data = json.dumps(body).encode('utf-8') if body is not None else None
        headers = {
            'Authorization': f'Bearer {_resolve_api_key(self.config)}',
            'Accept': 'application/json',
        }
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(
            f'{_dashboard_base_url(self.config)}{path}',
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read().decode('utf-8')
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'Browser profiles request failed ({exc.code}): {detail}') from exc
        if not payload:
            return {}
        return json.loads(payload)


def _dashboard_base_url(config: BrowserProfilesClientConfig) -> str:
    return (config.dashboard_url or os.environ.get('EVOLVE_DASHBOARD_URL') or DEFAULT_DASHBOARD_URL).rstrip('/')


def _resolve_api_key(config: BrowserProfilesClientConfig) -> str:
    api_key = config.api_key or os.environ.get('EVOLVE_API_KEY')
    if not api_key:
        raise ValueError('Browser profiles require EVOLVE_API_KEY or BrowserProfilesClientConfig(api_key=...)')
    return api_key
