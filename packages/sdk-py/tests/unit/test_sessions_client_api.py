"""
Unit tests for standalone sessions() historical trace access.

Coverage:
- SessionsClient.list() — delegates, parses, omits None params
- SessionsClient.get() — returns SessionInfo with snake_case fields
- SessionsClient.events() — returns parsed JSONL objects, passes since
- SessionsClient.download() — returns file path, passes to
- standalone sessions() — sync factory, gateway mode, explicit config
- Context manager / cleanup behavior
"""

import pytest
from unittest.mock import patch

from evolve import SessionInfo, SessionPage, SessionsClient, SessionsConfig
from evolve import sessions as sessions_factory


class MockBridgeManager:
    """Async bridge mock with sessions client RPC support."""

    def __init__(self):
        self.calls = []
        self.callbacks = {}
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    def on(self, event_type, callback):
        self.callbacks.setdefault(event_type, []).append(callback)

    async def call(self, method, params=None, timeout_s=None):
        self.calls.append((method, params, timeout_s))

        if method == 'sessions_list':
            return {
                'items': [
                    {
                        'id': 'sess-2',
                        'tag': 'demo-b',
                        'agent': 'claude',
                        'model': 'sonnet',
                        'provider': 'gateway',
                        'sandbox_id': 'sbx-2',
                        'state': 'ended',
                        'runtime_status': 'dead',
                        'cost': 1.25,
                        'created_at': '2026-03-05T11:00:00.000Z',
                        'ended_at': '2026-03-05T11:05:00.000Z',
                        'step_count': 42,
                        'tool_stats': {'bash': 3, 'edit': 7},
                    },
                    {
                        'id': 'sess-1',
                        'tag': 'demo-a',
                        'agent': 'codex',
                        'model': None,
                        'provider': 'gateway',
                        'sandbox_id': None,
                        'state': 'live',
                        'runtime_status': 'alive',
                        'cost': None,
                        'created_at': '2026-03-05T10:00:00.000Z',
                        'ended_at': None,
                        'step_count': 4,
                        'tool_stats': None,
                    },
                ],
                'next_cursor': 'cursor-2',
                'has_more': True,
            }

        if method == 'sessions_get':
            return {
                'id': params['id'],
                'tag': 'demo-a',
                'agent': 'codex',
                'model': 'gpt-5.2-codex',
                'provider': 'gateway',
                'sandbox_id': 'sbx-1',
                'state': 'ended',
                'runtime_status': 'dead',
                'cost': 0.42,
                'created_at': '2026-03-05T10:00:00.000Z',
                'ended_at': '2026-03-05T10:03:00.000Z',
                'step_count': 12,
                'tool_stats': {'bash': 2},
            }

        if method == 'sessions_events':
            return {
                'events': [
                    {'_meta': {'tag': 'demo-a'}},
                    {'jsonrpc': '2.0', 'method': 'session/update', 'params': {'index': 11}},
                ],
            }

        if method == 'sessions_download':
            return {'path': '/tmp/traces/demo-a.jsonl'}

        return {'status': 'ok'}


def _make_client(**config_kwargs):
    bridge = MockBridgeManager()
    client = SessionsClient(
        bridge,
        SessionsConfig(**config_kwargs),
        _owns_bridge=True,
    )
    return client, bridge


def _get_calls(bridge, method):
    return [c for c in bridge.calls if c[0] == method]


class TestSessionsClientList:
    @pytest.mark.asyncio
    async def test_delegates_to_bridge(self):
        client, bridge = _make_client(
            api_key='sk-test',
            dashboard_url='https://dash.example.com',
        )

        await client.list(
            limit=10,
            cursor='cursor-1',
            state='ended',
            agent='claude',
            tag_prefix='demo',
            sort='cost',
        )

        calls = _get_calls(bridge, 'sessions_list')
        assert len(calls) == 1
        params = calls[0][1]
        assert params['sessions'] == {
            'apiKey': 'sk-test',
            'dashboardUrl': 'https://dash.example.com',
        }
        assert params['limit'] == 10
        assert params['cursor'] == 'cursor-1'
        assert params['state'] == 'ended'
        assert params['agent'] == 'claude'
        assert params['tag_prefix'] == 'demo'
        assert params['sort'] == 'cost'

    @pytest.mark.asyncio
    async def test_parses_session_page(self):
        client, _ = _make_client()

        page = await client.list()

        assert isinstance(page, SessionPage)
        assert len(page.items) == 2
        assert isinstance(page.items[0], SessionInfo)
        assert page.items[0].id == 'sess-2'
        assert page.items[0].runtime_status == 'dead'
        assert page.items[0].tool_stats == {'bash': 3, 'edit': 7}
        assert page.next_cursor == 'cursor-2'
        assert page.has_more is True

    @pytest.mark.asyncio
    async def test_gateway_mode_uses_empty_sessions_config(self):
        client, bridge = _make_client()

        await client.list()

        calls = _get_calls(bridge, 'sessions_list')
        params = calls[0][1]
        assert params['sessions'] == {}

    @pytest.mark.asyncio
    async def test_omits_none_params(self):
        client, bridge = _make_client()

        await client.list()

        params = _get_calls(bridge, 'sessions_list')[0][1]
        assert 'limit' not in params
        assert 'cursor' not in params
        assert 'state' not in params
        assert 'agent' not in params
        assert 'tag_prefix' not in params
        assert 'sort' not in params


class TestSessionsClientGet:
    @pytest.mark.asyncio
    async def test_delegates_to_bridge(self):
        client, bridge = _make_client()

        await client.get('sess-123')

        calls = _get_calls(bridge, 'sessions_get')
        assert len(calls) == 1
        assert calls[0][1]['id'] == 'sess-123'

    @pytest.mark.asyncio
    async def test_returns_session_info(self):
        client, _ = _make_client()

        info = await client.get('sess-1')

        assert isinstance(info, SessionInfo)
        assert info.id == 'sess-1'
        assert info.model == 'gpt-5.2-codex'
        assert info.sandbox_id == 'sbx-1'
        assert info.state == 'ended'
        assert info.runtime_status == 'dead'
        assert info.step_count == 12


class TestSessionsClientEvents:
    @pytest.mark.asyncio
    async def test_returns_events(self):
        client, _ = _make_client()

        events = await client.events('sess-1')

        assert len(events) == 2
        assert events[0]['_meta']['tag'] == 'demo-a'
        assert events[1]['method'] == 'session/update'

    @pytest.mark.asyncio
    async def test_passes_since(self):
        client, bridge = _make_client()

        await client.events('sess-1', since=10)

        calls = _get_calls(bridge, 'sessions_events')
        assert len(calls) == 1
        params = calls[0][1]
        assert params['id'] == 'sess-1'
        assert params['since'] == 10


class TestSessionsClientDownload:
    @pytest.mark.asyncio
    async def test_returns_path(self):
        client, _ = _make_client()

        path = await client.download('sess-1')

        assert path == '/tmp/traces/demo-a.jsonl'

    @pytest.mark.asyncio
    async def test_passes_to_option(self):
        client, bridge = _make_client()

        await client.download('sess-1', to='/output/traces')

        calls = _get_calls(bridge, 'sessions_download')
        assert len(calls) == 1
        params = calls[0][1]
        assert params['id'] == 'sess-1'
        assert params['to'] == '/output/traces'


class TestStandaloneSessionsFactory:
    def test_sessions_is_sync(self):
        import asyncio

        result = sessions_factory(SessionsConfig(api_key='sk-test'))
        assert not asyncio.iscoroutine(result)
        assert isinstance(result, SessionsClient)

    @pytest.mark.asyncio
    async def test_factory_uses_bridge_manager(self):
        mock_bridge = MockBridgeManager()
        with patch('evolve.bridge.BridgeManager', return_value=mock_bridge):
            client = sessions_factory(SessionsConfig(api_key='sk-test'))
            await client.list(limit=1)
            await client.close()

        calls = _get_calls(mock_bridge, 'sessions_list')
        assert len(calls) == 1
        assert calls[0][1]['sessions'] == {'apiKey': 'sk-test'}


class TestContextManagerAndCleanup:
    @pytest.mark.asyncio
    async def test_context_manager_standalone(self):
        bridge = MockBridgeManager()
        client = SessionsClient(bridge, SessionsConfig(), _owns_bridge=True)

        async with client as sessions_client:
            page = await sessions_client.list(limit=1)
            assert len(page.items) == 2

        assert bridge.stopped

    @pytest.mark.asyncio
    async def test_close_standalone_stops_bridge(self):
        bridge = MockBridgeManager()
        client = SessionsClient(bridge, SessionsConfig(), _owns_bridge=True)

        await client.close()

        assert bridge.stopped

    @pytest.mark.asyncio
    async def test_ensure_ready_starts_bridge(self):
        bridge = MockBridgeManager()
        client = SessionsClient(bridge, SessionsConfig())

        assert not bridge.started
        await client.list()
        assert bridge.started
