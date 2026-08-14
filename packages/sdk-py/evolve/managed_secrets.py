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


@dataclass
class ManagedSecretWriteResult:
    #: 'created' for a fresh (name, label) identity; 'updated' when the
    #: request restated the stored value byte-for-byte and the row converged
    #: (the one path where delivery and scoping are editable). A DIFFERENT
    #: value under an existing identity never overwrites — the server
    #: refuses typed (HTTP 409, code ``secret_exists``).
    status: str
    secret: ManagedSecretMetadata


@dataclass
class ManagedSecretDeleteResult:
    ok: bool
    name: str
    #: The label of the row that was deleted (resolution may have defaulted it).
    label: str


class ManagedSecretsClient:
    """Dashboard-stored managed secrets: list metadata, set and delete.

    ``set`` speaks the API-key write door (``POST /api/managed-secrets``):
    the VALUE rides the HTTPS body and is sealed server-side with the vault
    cipher — the same posture the inline job-secrets door on job create
    established; no read ever returns it. LLM provider keys (BYOK) are not
    writable here — they gate billing and stay behind the signed-in
    dashboard session.
    """

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

    async def set(
        self,
        *,
        name: str,
        value: str,
        delivery: str,
        label: Optional[str] = None,
        allowed_hosts: Optional[List[str]] = None,
        allowed_path_prefixes: Optional[List[str]] = None,
        allowed_methods: Optional[List[str]] = None,
    ) -> ManagedSecretWriteResult:
        """Create or update an env secret (identity = (name, label)).

        ``delivery`` is required: 'brokered' needs the allowed_hosts /
        allowed_path_prefixes / allowed_methods scoping triple, 'direct'
        refuses it. An existing identity converges only on a byte-equal
        restatement of the stored value; a different value refuses typed —
        rotate by delete + set, or use another label.
        """
        body: Dict[str, Any] = {'name': name, 'value': value, 'delivery': delivery}
        if label is not None:
            body['label'] = label
        if allowed_hosts is not None:
            body['allowed_hosts'] = list(allowed_hosts)
        if allowed_path_prefixes is not None:
            body['allowed_path_prefixes'] = list(allowed_path_prefixes)
        if allowed_methods is not None:
            body['allowed_methods'] = list(allowed_methods)
        result = await self._request_json('/api/managed-secrets', method='POST', body=body)
        return ManagedSecretWriteResult(
            status=str(result.get('status') or ''),
            secret=_metadata_from_dict(result.get('secret') or {}),
        )

    async def delete(
        self, *, name: str, label: Optional[str] = None
    ) -> ManagedSecretDeleteResult:
        """Delete an env secret by (name, label).

        An omitted label resolves by the shared law: the 'default' row, else
        the single row, else a typed ambiguity refusal naming every label.
        """
        body: Dict[str, Any] = {'name': name}
        if label is not None:
            body['label'] = label
        result = await self._request_json('/api/managed-secrets', method='DELETE', body=body)
        return ManagedSecretDeleteResult(
            ok=bool(result.get('ok')),
            name=str(result.get('name') or name),
            label=str(result.get('label') or ''),
        )

    async def _request_json(
        self,
        path: str,
        *,
        method: str = 'GET',
        body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        return await asyncio.to_thread(
            _http.request_json,
            f'{_dashboard_base_url(self.config)}{path}',
            api_key=_resolve_api_key(self.config),
            error_prefix='Managed secrets',
            method=method,
            body=body,
        )


def _dashboard_base_url(config: ManagedSecretsClientConfig) -> str:
    return (config.dashboard_url or os.environ.get('EVOLVE_DASHBOARD_URL') or DEFAULT_DASHBOARD_URL).rstrip('/')


def _resolve_api_key(config: ManagedSecretsClientConfig) -> str:
    api_key = config.api_key or os.environ.get('EVOLVE_API_KEY')
    if not api_key:
        raise ValueError('Managed secrets require EVOLVE_API_KEY or ManagedSecretsClientConfig(api_key=...)')
    return api_key
