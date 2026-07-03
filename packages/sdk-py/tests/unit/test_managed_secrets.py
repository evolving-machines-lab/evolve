"""Unit tests for managed secrets Python parity."""

import json
from unittest.mock import patch

import pytest

from evolve import Evolve, ManagedSecretRef, ManagedSecretsClientConfig, managed_secrets


class MockBridgeManager:
    def __init__(self):
        self.calls = []
        self.callbacks = {}

    async def start(self):
        return None

    async def stop(self):
        return None

    def on(self, event_type, callback):
        self.callbacks.setdefault(event_type, []).append(callback)

    async def call(self, method, params=None, timeout_s=None):
        self.calls.append((method, params, timeout_s))
        if method == 'initialize':
            return {'status': 'ok'}
        return {'status': 'ok'}


@pytest.mark.asyncio
async def test_managed_secrets_forward_to_bridge():
    mock_bridge = MockBridgeManager()
    with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
        kit = Evolve(
            managed_secrets=[
                ManagedSecretRef(name='GITHUB_TOKEN', as_name='GH_TOKEN'),
                {'name': 'STRIPE_KEY', 'label': 'prod'},
            ],
        )
        await kit._ensure_initialized()

    initialize_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
    assert len(initialize_calls) == 1
    params = initialize_calls[0][1]
    assert params['managed_secrets'] == [
        {'name': 'GITHUB_TOKEN', 'as': 'GH_TOKEN'},
        {'name': 'STRIPE_KEY', 'label': 'prod'},
    ]


def test_managed_secret_ref_to_dict_maps_as_name():
    ref = ManagedSecretRef(name='API_KEY', label='prod', as_name='SERVICE_TOKEN')
    assert ref.to_dict() == {
        'name': 'API_KEY',
        'label': 'prod',
        'as': 'SERVICE_TOKEN',
    }


@pytest.mark.asyncio
async def test_managed_secrets_client_lists_metadata(monkeypatch):
    seen = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps({
                'secrets': [
                    {
                        'id': 'secret_1',
                        'name': 'GITHUB_TOKEN',
                        'label': 'default',
                        'enabled': True,
                        'allowedHosts': ['api.github.com'],
                        'allowedPathPrefixes': ['/user'],
                        'allowedMethods': ['GET'],
                        'createdAt': '2026-01-01T00:00:00.000Z',
                        'updatedAt': '2026-01-02T00:00:00.000Z',
                        'lastUsedAt': None,
                    },
                ],
            }).encode('utf-8')

    def fake_urlopen(request, timeout):
        seen['url'] = request.full_url
        seen['authorization'] = request.get_header('Authorization')
        seen['timeout'] = timeout
        return Response()

    monkeypatch.setattr('urllib.request.urlopen', fake_urlopen)

    client = managed_secrets(ManagedSecretsClientConfig(
        api_key='sk-evolve',
        dashboard_url='https://dashboard.test',
    ))
    secrets = await client.list()

    assert seen == {
        'url': 'https://dashboard.test/api/managed-secrets',
        'authorization': 'Bearer sk-evolve',
        'timeout': 30,
    }
    assert len(secrets) == 1
    assert secrets[0].name == 'GITHUB_TOKEN'
    assert secrets[0].allowed_hosts == ['api.github.com']
