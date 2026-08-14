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
    # The label lane: identical wire shape to the evals lane's JobSecretRef —
    # {name, label?, as?} — resolved by the server's one shared law.
    assert ManagedSecretRef(name='GITHUB_TOKEN', label='prod', as_name='GH_TOKEN').to_dict() == {
        'name': 'GITHUB_TOKEN',
        'label': 'prod',
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
                    'label': 'prod',
                    'delivery': 'brokered',
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
    assert result[0].label == 'prod'
    assert result[0].delivery == 'brokered'
    assert result[0].allowed_hosts == ['api.github.com']
    assert 'ghp_' not in repr(result)


class _FakeWriteResponse:
    """One canned JSON answer, capturing nothing — the request rides urlopen."""

    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self._payload).encode()


@pytest.mark.asyncio
async def test_managed_secrets_client_set_speaks_snake_case_wire(monkeypatch):
    opener = Mock(return_value=_FakeWriteResponse({
        'status': 'created',
        'secret': {
            'id': 'secret_2',
            'name': 'GITHUB_TOKEN',
            'label': 'default',
            'delivery': 'brokered',
            'allowed_hosts': ['api.github.com'],
            'allowed_path_prefixes': ['/'],
            'allowed_methods': ['GET'],
            'enabled': True,
            'created_at': '2026-01-01T00:00:00.000Z',
            'updated_at': '2026-01-01T00:00:00.000Z',
            'last_used_at': None,
        },
    }))
    monkeypatch.setattr('evolve._http.urlopen', opener)

    client = managed_secrets(ManagedSecretsClientConfig(api_key='ev_key', dashboard_url='https://dashboard.test'))
    result = await client.set(
        name='GITHUB_TOKEN',
        value='ghp_secret_value',
        delivery='brokered',
        allowed_hosts=['api.github.com'],
        allowed_path_prefixes=['/'],
        allowed_methods=['GET'],
    )

    request = opener.call_args[0][0]
    assert request.get_method() == 'POST'
    assert request.full_url.endswith('/api/managed-secrets')
    body = json.loads(request.data.decode())
    assert body['allowed_hosts'] == ['api.github.com']
    assert body['delivery'] == 'brokered'
    assert body['value'] == 'ghp_secret_value'
    assert result.status == 'created'
    # The snake_case response parses through the same tolerant reader as list.
    assert result.secret.allowed_hosts == ['api.github.com']
    assert result.secret.delivery == 'brokered'
    # The stored value is never echoed back by the metadata document.
    assert 'ghp_secret_value' not in repr(result)


@pytest.mark.asyncio
async def test_managed_secrets_client_delete_names_the_labeled_row(monkeypatch):
    opener = Mock(return_value=_FakeWriteResponse({
        'ok': True,
        'name': 'GITHUB_TOKEN',
        'label': 'staging',
    }))
    monkeypatch.setattr('evolve._http.urlopen', opener)

    client = managed_secrets(ManagedSecretsClientConfig(api_key='ev_key', dashboard_url='https://dashboard.test'))
    result = await client.delete(name='GITHUB_TOKEN', label='staging')

    request = opener.call_args[0][0]
    assert request.get_method() == 'DELETE'
    assert json.loads(request.data.decode()) == {'name': 'GITHUB_TOKEN', 'label': 'staging'}
    assert result.ok is True
    assert result.label == 'staging'
