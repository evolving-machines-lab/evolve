"""Standalone managed secrets client."""

import asyncio
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from . import _http
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
    #: The row's label — secrets are unique by (name, label), 'default' when
    #: none was chosen at store time. None: servers older than the label
    #: lane omit it.
    label: Optional[str] = None
    #: The row's delivery mode: 'brokered' (the value never enters any
    #: sandbox — placeholder env + egress-proxy swap toward allowed_hosts)
    #: or 'direct' (the raw value is placed in the sandbox environment —
    #: URL-parameter keys, gRPC, websockets). None: servers older than the
    #: delivery lane omit it and always broker.
    delivery: Optional[str] = None


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
        label=data.get('label'),
        delivery=data.get('delivery'),
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
        return await asyncio.to_thread(
            _http.request_json,
            f'{_dashboard_base_url(self.config)}{path}',
            api_key=_resolve_api_key(self.config),
            error_prefix='Managed secrets',
        )


def _dashboard_base_url(config: ManagedSecretsClientConfig) -> str:
    return (config.dashboard_url or os.environ.get('EVOLVE_DASHBOARD_URL') or DEFAULT_DASHBOARD_URL).rstrip('/')


def _resolve_api_key(config: ManagedSecretsClientConfig) -> str:
    api_key = config.api_key or os.environ.get('EVOLVE_API_KEY')
    if not api_key:
        raise ValueError('Managed secrets require EVOLVE_API_KEY or ManagedSecretsClientConfig(api_key=...)')
    return api_key
