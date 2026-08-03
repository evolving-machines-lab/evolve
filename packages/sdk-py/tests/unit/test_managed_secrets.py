import json
from unittest.mock import AsyncMock, Mock

import pytest

from evolve import Evolve, ManagedSecretRef, ManagedSecretsClientConfig, managed_secrets


def test_managed_secret_ref_to_dict():
    assert ManagedSecretRef(name='GITHUB_TOKEN').to_dict() == {'name': 'GITHUB_TOKEN'}
    assert ManagedSecretRef(name='GITHUB_TOKEN', as_name='GH_TOKEN').to_dict() == {
        'name': 'GITHUB_TOKEN',
        'as': 'GH_TOKEN',
    }


@pytest.mark.asyncio
async def test_evolve_forwards_managed_secrets_to_bridge(monkeypatch):
    calls = []

    class FakeBridge:
        async def start(self):
            return None

        async def call(self, method, params=None, timeout_s=None):
            calls.append((method, params, timeout_s))
            return {'ok': True}

    evolve = Evolve(managed_secrets=[ManagedSecretRef(name='GITHUB_TOKEN')])
    evolve.bridge = FakeBridge()

    await evolve._ensure_initialized()

    initialize = calls[0]
    assert initialize[0] == 'initialize'
    assert initialize[1]['managed_secrets'] == [{'name': 'GITHUB_TOKEN'}]


def test_evolve_rejects_empty_managed_secrets():
    with pytest.raises(ValueError, match='at least one secret'):
        Evolve(managed_secrets=[])


@pytest.mark.asyncio
async def test_managed_secrets_client_lists_metadata(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps({
                'secrets': [{
                    'id': 'secret_1',
                    'name': 'GITHUB_TOKEN',
                    'allowedHosts': ['api.github.com'],
                    'allowedPathPrefixes': ['/user'],
                    'allowedMethods': ['GET'],
                    'createdAt': '2026-01-01T00:00:00.000Z',
                    'updatedAt': '2026-01-02T00:00:00.000Z',
                    'lastUsedAt': None,
                }],
            }).encode()

    opener = Mock(return_value=FakeResponse())
    monkeypatch.setattr('evolve._http.urlopen', opener)

    client = managed_secrets(ManagedSecretsClientConfig(api_key='ev_key', dashboard_url='https://dashboard.test'))
    result = await client.list()

    assert len(result) == 1
    assert result[0].name == 'GITHUB_TOKEN'
    assert result[0].allowed_hosts == ['api.github.com']
    assert 'ghp_' not in repr(result)
