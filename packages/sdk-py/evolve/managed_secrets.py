"""Standalone managed secrets client."""

import asyncio
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .config import ManagedSecretsClientConfig


DEFAULT_DASHBOARD_URL = 'https://dashboard.evolvingmachines.ai'


@dataclass
class ManagedSecretMetadata:
    id: str
    name: str
    allowed_hosts: List[str]
    allowed_path_prefixes: List[str]
    allowed_methods: List[str]
    created_at: str
    updated_at: str
    last_used_at: Optional[str]


def _metadata_from_dict(data: Dict[str, Any]) -> ManagedSecretMetadata:
    return ManagedSecretMetadata(
        id=data['id'],
        name=data['name'],
        allowed_hosts=list(data.get('allowedHosts') or data.get('allowed_hosts') or []),
        allowed_path_prefixes=list(data.get('allowedPathPrefixes') or data.get('allowed_path_prefixes') or []),
        allowed_methods=list(data.get('allowedMethods') or data.get('allowed_methods') or []),
        created_at=data.get('createdAt') or data.get('created_at') or '',
        updated_at=data.get('updatedAt') or data.get('updated_at') or '',
        last_used_at=data.get('lastUsedAt') or data.get('last_used_at'),
    )


class ManagedSecretsClient:
    """List Dashboard-stored managed secret metadata."""

    def __init__(self, config: Optional[ManagedSecretsClientConfig] = None):
        self.config = config or ManagedSecretsClientConfig()

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()

    async def close(self):
        return None

    async def list(self) -> List[ManagedSecretMetadata]:
        result = await self._request_json('/api/managed-secrets')
        return [_metadata_from_dict(item) for item in result.get('secrets', [])]

    async def _request_json(self, path: str) -> Dict[str, Any]:
        return await asyncio.to_thread(self._request_json_sync, path)

    def _request_json_sync(self, path: str) -> Dict[str, Any]:
        request = urllib.request.Request(
            f'{_dashboard_base_url(self.config)}{path}',
            headers={
                'Authorization': f'Bearer {_resolve_api_key(self.config)}',
                'Accept': 'application/json',
            },
            method='GET',
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read().decode('utf-8')
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'Managed secrets request failed ({exc.code}): {detail}') from exc
        return json.loads(payload) if payload else {}


def _dashboard_base_url(config: ManagedSecretsClientConfig) -> str:
    return (config.dashboard_url or os.environ.get('EVOLVE_DASHBOARD_URL') or DEFAULT_DASHBOARD_URL).rstrip('/')


def _resolve_api_key(config: ManagedSecretsClientConfig) -> str:
    api_key = config.api_key or os.environ.get('EVOLVE_API_KEY')
    if not api_key:
        raise ValueError('Managed secrets require EVOLVE_API_KEY or ManagedSecretsClientConfig(api_key=...)')
    return api_key
