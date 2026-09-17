"""Unit tests for sandbox observation — the Python mirror of the provider surface (inspect, files, watch, metrics, typed errors)."""

import asyncio
import base64

import pytest
from unittest.mock import patch

from evolve import (
    Evolve,
    FileInfo,
    FilesystemEvent,
    SandboxFeatureUnsupportedError,
    SandboxMetrics,
    SandboxNotRunningError,
    SandboxPathNotFoundError,
    SandboxView,
)
from evolve.bridge import BridgeManager


ENTRY = {
    'name': 'link',
    'path': '/tmp/p/link',
    'type': 'symlink',
    'size': 5,
    'mtime': '2026-09-16T20:48:03.710Z',
    'mode': '0777',
    'owner': 'root',
    'group': 'root',
    'target': 'a.txt',
}

FILE_ENTRY = {
    'name': 'a.txt',
    'path': '/tmp/p/a.txt',
    'type': 'file',
    'size': 5,
    'mtime': '2026-09-16T20:48:03.710Z',
    'mode': '0644',
    'owner': 'root',
    'group': 'root',
}


class MockBridgeManager(BridgeManager):
    """The real BridgeManager with only the process stubbed: on() and _handle_event() are the real registry,
    so a test cannot pass on an event type the bridge would refuse."""

    def __init__(self, responses=None):
        super().__init__()
        self.calls = []
        self._responses = responses or {}

    async def start(self):
        return None

    async def stop(self):
        return None

    def emit(self, params):
        self._handle_event(params)

    async def call(self, method, params=None, timeout_s=None):
        self.calls.append((method, params, timeout_s))
        if method == 'initialize':
            return {'status': 'ok'}
        if method in self._responses:
            resp = self._responses[method]
            if callable(resp):
                return resp(params)
            if isinstance(resp, Exception):
                raise resp
            return resp
        if method == 'sandbox_inspect':
            return {'handle': 'h-1', 'sandbox_id': params['sandbox_id']}
        if method == 'sandbox_files_list':
            return {'entries': [FILE_ENTRY, ENTRY]}
        if method == 'sandbox_files_stat':
            return {'entry': ENTRY}
        if method == 'sandbox_files_read_range':
            return {'data_base64': base64.b64encode(bytes(range(params['offset'], params['offset'] + params['length']))).decode('ascii')}
        if method == 'sandbox_watch_dir':
            return {'watch_id': 'w-1'}
        if method == 'sandbox_metrics':
            return {'metrics': {'cpu_pct': 7.5, 'mem_used_mb': 3.0, 'mem_total_mb': 1024.0, 'disk_used_mb': 512.0, 'sampled_at': '2026-09-16T20:48:15.000Z', 'source': 'e2b:getMetrics'}}
        return {'status': 'ok'}


def _kit(mock):
    with patch('evolve.agent.BridgeManager', return_value=mock):
        return Evolve()


class TestInspect:
    @pytest.mark.asyncio
    async def test_inspect_returns_view_bound_to_handle(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live', user='root')
        assert isinstance(view, SandboxView)
        assert view.sandbox_id == 'sb-live'
        call = next(c for c in mock.calls if c[0] == 'sandbox_inspect')
        assert call[1] == {'sandbox_id': 'sb-live', 'user': 'root'}

    @pytest.mark.asyncio
    async def test_inspect_omits_user_when_not_given(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        await kit.inspect_sandbox('sb-live')
        call = next(c for c in mock.calls if c[0] == 'sandbox_inspect')
        assert call[1] == {'sandbox_id': 'sb-live'}

    @pytest.mark.asyncio
    async def test_close_releases_handle(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        await view.close()
        assert ('sandbox_release', {'handle': 'h-1'}, None) in mock.calls


class TestFiles:
    @pytest.mark.asyncio
    async def test_list_parses_uniform_entries(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        entries = await view.files.list('/tmp/p')
        assert [type(e) for e in entries] == [FileInfo, FileInfo]
        assert entries[0] == FileInfo(name='a.txt', path='/tmp/p/a.txt', type='file', size=5, mtime='2026-09-16T20:48:03.710Z', mode='0644', owner='root', group='root')
        assert entries[1].type == 'symlink' and entries[1].target == 'a.txt'
        assert ('sandbox_files_list', {'handle': 'h-1', 'path': '/tmp/p'}, None) in mock.calls

    @pytest.mark.asyncio
    async def test_stat_parses_one_entry(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        info = await view.files.stat('/tmp/p/link')
        assert info == FileInfo(name='link', path='/tmp/p/link', type='symlink', size=5, mtime='2026-09-16T20:48:03.710Z', mode='0777', owner='root', group='root', target='a.txt')
        assert ('sandbox_files_stat', {'handle': 'h-1', 'path': '/tmp/p/link'}, None) in mock.calls

    @pytest.mark.asyncio
    async def test_read_range_returns_exact_bytes(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        data = await view.files.read_range('/tmp/p/big.bin', offset=10, length=5)
        assert data == bytes([10, 11, 12, 13, 14])
        assert isinstance(data, bytes)
        assert ('sandbox_files_read_range', {'handle': 'h-1', 'path': '/tmp/p/big.bin', 'offset': 10, 'length': 5}, None) in mock.calls

    @pytest.mark.asyncio
    async def test_watch_dir_delivers_events_and_stops(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        seen = []
        watch = await view.files.watch_dir('/tmp/p', seen.append, recursive=True)
        assert ('sandbox_watch_dir', {'handle': 'h-1', 'path': '/tmp/p', 'recursive': True}, None) in mock.calls
        mock.emit({'type': 'fs', 'watch_id': 'w-1', 'path': '/tmp/p/sub/b.txt', 'event': 'create'})
        mock.emit({'type': 'fs', 'watch_id': 'w-other', 'path': '/elsewhere', 'event': 'write'})
        assert seen == [FilesystemEvent(path='/tmp/p/sub/b.txt', type='create')]
        await watch.stop()
        assert ('sandbox_watch_stop', {'watch_id': 'w-1'}, None) in mock.calls
        mock.emit({'type': 'fs', 'watch_id': 'w-1', 'path': '/tmp/p/late', 'event': 'remove'})
        assert len(seen) == 1


class TestMetrics:
    @pytest.mark.asyncio
    async def test_metrics_parses_sample(self):
        mock = MockBridgeManager()
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        m = await view.metrics()
        assert m == SandboxMetrics(cpu_pct=7.5, mem_used_mb=3.0, mem_total_mb=1024.0, disk_used_mb=512.0, sampled_at='2026-09-16T20:48:15.000Z', source='e2b:getMetrics')

    @pytest.mark.asyncio
    async def test_metrics_none_when_no_sample_yet(self):
        mock = MockBridgeManager(responses={'sandbox_metrics': {'metrics': None}})
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        assert await view.metrics() is None


class TestBridgeEvents:
    def test_fs_is_a_registered_event_type_and_dispatches_whole_params(self):
        bridge = BridgeManager()
        seen = []
        bridge.on('fs', seen.append)
        event = {'type': 'fs', 'watch_id': 'w-1', 'path': '/tmp/p/a.txt', 'event': 'write'}
        bridge._handle_event(event)
        assert seen == [event]


class TestTypedErrors:
    def test_bridge_maps_typed_error_names(self):
        bridge = BridgeManager()
        loop = asyncio.new_event_loop()
        try:
            cases = [
                ({'errorType': 'SandboxFeatureUnsupportedError', 'feature': 'files.watchDir', 'provider': 'daytona'}, SandboxFeatureUnsupportedError),
                ({'errorType': 'SandboxPathNotFoundError', 'path': '/x', 'provider': 'e2b'}, SandboxPathNotFoundError),
                ({'errorType': 'SandboxNotRunningError', 'sandboxId': 'sb', 'provider': 'modal', 'state': 'exited with code 137'}, SandboxNotRunningError),
            ]
            for i, (data, cls) in enumerate(cases, start=1):
                future = loop.create_future()
                bridge.pending_requests[i] = future
                bridge._handle_response({'jsonrpc': '2.0', 'id': i, 'error': {'code': -32603, 'message': f'typed {i}', 'data': data}})
                err = future.exception()
                assert isinstance(err, cls), f'{data} → {type(err)}'
                assert str(err) == f'typed {i}'
            unsupported = bridge.pending_requests.get(1)
            assert unsupported is None
        finally:
            loop.close()

    def test_typed_error_fields(self):
        err = SandboxFeatureUnsupportedError('daytona does not support files.watchDir', feature='files.watchDir', provider='daytona')
        assert err.feature == 'files.watchDir' and err.provider == 'daytona'
        nf = SandboxPathNotFoundError('e2b: no such file', path='/x', provider='e2b')
        assert nf.path == '/x' and nf.provider == 'e2b'
        nr = SandboxNotRunningError('not running', sandbox_id='sb', provider='modal', state='exited with code 137')
        assert nr.sandbox_id == 'sb' and nr.state == 'exited with code 137'

    @pytest.mark.asyncio
    async def test_watch_refusal_surfaces_typed(self):
        mock = MockBridgeManager(responses={'sandbox_watch_dir': SandboxFeatureUnsupportedError('daytona does not support files.watchDir', feature='files.watchDir', provider='daytona')})
        kit = _kit(mock)
        view = await kit.inspect_sandbox('sb-live')
        with pytest.raises(SandboxFeatureUnsupportedError) as excinfo:
            await view.files.watch_dir('/tmp/p', lambda e: None)
        assert excinfo.value.provider == 'daytona'
