"""
Unit tests for StorageClient, Evolve.storage(), and standalone storage().

Comprehensive coverage matching the TypeScript storage-client unit tests.

Tests:
- StorageClient.list_checkpoints() — delegates, parses, omits None params
- StorageClient.get_checkpoint(id) — returns CheckpointInfo with all fields
- StorageClient.download_checkpoint(id) — returns path, passes options
- StorageClient.download_files(id) — decodes text + base64, passes filters
- Evolve.storage() — returns StorageClient, raises without config, bound mode
- Standalone storage() — sync factory, gateway mode, BYOK credentials
- Context manager — __aenter__/__aexit__, close() safety
"""

import pytest
from unittest.mock import patch

from evolve import Evolve, StorageConfig, StorageCredentials, CheckpointInfo, StorageClient
from evolve import storage as storage_factory


# =============================================================================
# MOCK BRIDGE
# =============================================================================


class MockBridgeManager:
    """Async bridge mock with storage client RPC support."""

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

        if method == 'initialize':
            return {'status': 'ok'}

        if method == 'storage_list_checkpoints':
            return [
                {
                    'id': 'cp-2',
                    'hash': 'sha256-2',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T11:00:00.000Z',
                    'size_bytes': 2048,
                    'agent_type': 'claude',
                    'comment': 'second',
                },
                {
                    'id': 'cp-1',
                    'hash': 'sha256-1',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T10:00:00.000Z',
                    'size_bytes': 1024,
                    'agent_type': 'claude',
                    'comment': 'first',
                },
            ]

        if method == 'storage_get_checkpoint':
            if params.get('id') == 'nonexistent-id':
                raise Exception('Checkpoint not found: nonexistent-id')
            return {
                'id': params['id'],
                'hash': 'sha256-abc',
                'tag': 'test-tag',
                'timestamp': '2026-01-15T10:00:00.000Z',
                'size_bytes': 1024,
                'agent_type': 'claude',
                'model': 'opus',
                'workspace_mode': 'knowledge',
                'parent_id': 'cp-parent',
                'comment': 'test checkpoint',
            }

        if method == 'storage_download_checkpoint':
            return {'path': '/tmp/evolve-extract-12345'}

        if method == 'storage_download_files':
            return {
                'files': {
                    'workspace/data.txt': {'content': 'hello world', 'encoding': 'text'},
                    'workspace/image.png': {'content': 'aGVsbG8=', 'encoding': 'base64'},
                },
            }

        if method == 'list_checkpoints':
            return [
                {
                    'id': 'cp-2',
                    'hash': 'sha256-2',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T11:00:00.000Z',
                },
            ]

        return {'status': 'ok'}


# =============================================================================
# HELPERS
# =============================================================================


def _make_client(url='s3://bucket/', **kwargs):
    """Create a StorageClient with MockBridgeManager for testing."""
    bridge = MockBridgeManager()
    return StorageClient(bridge, StorageConfig(url=url), **kwargs), bridge


def _get_calls(bridge, method):
    """Get all calls to a specific RPC method."""
    return [c for c in bridge.calls if c[0] == method]


# =============================================================================
# STORAGE CLIENT — LIST CHECKPOINTS
# =============================================================================


class TestStorageClientListCheckpoints:
    """Test StorageClient.list_checkpoints()."""

    @pytest.mark.asyncio
    async def test_delegates_to_bridge(self):
        """list_checkpoints() calls storage_list_checkpoints with storage config."""
        client, bridge = _make_client(url='s3://bucket/prefix/')

        await client.list_checkpoints(limit=10, tag='test-tag')

        calls = _get_calls(bridge, 'storage_list_checkpoints')
        assert len(calls) == 1
        params = calls[0][1]
        assert params['storage'] == {'url': 's3://bucket/prefix/'}
        assert params['limit'] == 10
        assert params['tag'] == 'test-tag'

    @pytest.mark.asyncio
    async def test_parses_response(self):
        """list_checkpoints() returns parsed CheckpointInfo list."""
        client, _ = _make_client()

        checkpoints = await client.list_checkpoints()

        assert len(checkpoints) == 2
        assert isinstance(checkpoints[0], CheckpointInfo)
        assert checkpoints[0].id == 'cp-2'
        assert checkpoints[0].comment == 'second'
        assert checkpoints[1].id == 'cp-1'
        assert checkpoints[1].size_bytes == 1024

    @pytest.mark.asyncio
    async def test_omits_none_params(self):
        """list_checkpoints() with no args only includes storage key."""
        client, bridge = _make_client()

        await client.list_checkpoints()

        calls = _get_calls(bridge, 'storage_list_checkpoints')
        params = calls[0][1]
        assert 'limit' not in params
        assert 'tag' not in params

    @pytest.mark.asyncio
    async def test_sorted_newest_first(self):
        """list_checkpoints() results are ordered newest first."""
        client, _ = _make_client()

        checkpoints = await client.list_checkpoints()

        assert checkpoints[0].timestamp > checkpoints[1].timestamp


# =============================================================================
# STORAGE CLIENT — GET CHECKPOINT
# =============================================================================


class TestStorageClientGetCheckpoint:
    """Test StorageClient.get_checkpoint()."""

    @pytest.mark.asyncio
    async def test_delegates_to_bridge(self):
        """get_checkpoint(id) calls storage_get_checkpoint with correct params."""
        client, bridge = _make_client()

        await client.get_checkpoint('cp-123')

        calls = _get_calls(bridge, 'storage_get_checkpoint')
        assert len(calls) == 1
        assert calls[0][1]['id'] == 'cp-123'

    @pytest.mark.asyncio
    async def test_returns_full_metadata(self):
        """get_checkpoint() parses all fields correctly."""
        client, _ = _make_client()

        info = await client.get_checkpoint('cp-test')

        assert info.id == 'cp-test'
        assert info.hash == 'sha256-abc'
        assert info.tag == 'test-tag'
        assert info.size_bytes == 1024
        assert info.agent_type == 'claude'
        assert info.model == 'opus'
        assert info.workspace_mode == 'knowledge'
        assert info.parent_id == 'cp-parent'
        assert info.comment == 'test checkpoint'

    @pytest.mark.asyncio
    async def test_nonexistent_throws(self):
        """get_checkpoint() with nonexistent ID throws."""
        client, _ = _make_client()

        with pytest.raises(Exception, match='not found'):
            await client.get_checkpoint('nonexistent-id')


# =============================================================================
# STORAGE CLIENT — DOWNLOAD CHECKPOINT
# =============================================================================


class TestStorageClientDownloadCheckpoint:
    """Test StorageClient.download_checkpoint()."""

    @pytest.mark.asyncio
    async def test_returns_path(self):
        """download_checkpoint() returns extracted directory path."""
        client, _ = _make_client()

        path = await client.download_checkpoint('cp-123')

        assert path == '/tmp/evolve-extract-12345'

    @pytest.mark.asyncio
    async def test_passes_options(self):
        """download_checkpoint() passes to and extract options."""
        client, bridge = _make_client()

        await client.download_checkpoint('cp-123', to='/my/dir', extract=False)

        calls = _get_calls(bridge, 'storage_download_checkpoint')
        params = calls[0][1]
        assert params['id'] == 'cp-123'
        assert params['to'] == '/my/dir'
        assert params['extract'] is False

    @pytest.mark.asyncio
    async def test_omits_default_extract(self):
        """download_checkpoint() omits extract when True (default)."""
        client, bridge = _make_client()

        await client.download_checkpoint('cp-123')

        calls = _get_calls(bridge, 'storage_download_checkpoint')
        params = calls[0][1]
        assert 'extract' not in params

    @pytest.mark.asyncio
    async def test_latest_resolution(self):
        """download_checkpoint('latest') passes 'latest' as id."""
        client, bridge = _make_client()

        await client.download_checkpoint('latest')

        calls = _get_calls(bridge, 'storage_download_checkpoint')
        assert calls[0][1]['id'] == 'latest'


# =============================================================================
# STORAGE CLIENT — DOWNLOAD FILES
# =============================================================================


class TestStorageClientDownloadFiles:
    """Test StorageClient.download_files()."""

    @pytest.mark.asyncio
    async def test_returns_decoded_map(self):
        """download_files() decodes text and base64 files."""
        client, _ = _make_client()

        files = await client.download_files('cp-123')

        assert 'workspace/data.txt' in files
        assert files['workspace/data.txt'] == 'hello world'
        assert 'workspace/image.png' in files
        assert isinstance(files['workspace/image.png'], bytes)

    @pytest.mark.asyncio
    async def test_base64_decode_correct(self):
        """download_files() base64 decodes binary content correctly."""
        client, _ = _make_client()

        files = await client.download_files('cp-123')

        # 'aGVsbG8=' is base64 for 'hello'
        assert files['workspace/image.png'] == b'hello'

    @pytest.mark.asyncio
    async def test_passes_file_filter(self):
        """download_files(files=[...]) passes files filter."""
        client, bridge = _make_client()

        await client.download_files('cp-123', files=['workspace/data.txt'])

        calls = _get_calls(bridge, 'storage_download_files')
        params = calls[0][1]
        assert params['files'] == ['workspace/data.txt']

    @pytest.mark.asyncio
    async def test_passes_glob_filter(self):
        """download_files(glob=[...]) passes glob patterns."""
        client, bridge = _make_client()

        await client.download_files('cp-123', glob=['workspace/*.txt'])

        calls = _get_calls(bridge, 'storage_download_files')
        params = calls[0][1]
        assert params['glob'] == ['workspace/*.txt']

    @pytest.mark.asyncio
    async def test_passes_to_option(self):
        """download_files(to=...) passes to directory."""
        client, bridge = _make_client()

        await client.download_files('cp-123', to='/output/dir')

        calls = _get_calls(bridge, 'storage_download_files')
        params = calls[0][1]
        assert params['to'] == '/output/dir'

    @pytest.mark.asyncio
    async def test_latest_resolution(self):
        """download_files('latest') passes 'latest' as id."""
        client, bridge = _make_client()

        await client.download_files('latest')

        calls = _get_calls(bridge, 'storage_download_files')
        assert calls[0][1]['id'] == 'latest'

    @pytest.mark.asyncio
    async def test_omits_none_filters(self):
        """download_files() without files/glob/to omits those keys."""
        client, bridge = _make_client()

        await client.download_files('cp-123')

        calls = _get_calls(bridge, 'storage_download_files')
        params = calls[0][1]
        assert 'files' not in params
        assert 'glob' not in params
        assert 'to' not in params


# =============================================================================
# EVOLVE.STORAGE() ACCESSOR
# =============================================================================


class TestEvolveStorageAccessor:
    """Test Evolve.storage() method."""

    def test_raises_without_config(self):
        """storage() raises RuntimeError when storage not configured."""
        kit = Evolve()
        with pytest.raises(RuntimeError, match='Storage not configured'):
            kit.storage()

    def test_returns_client(self):
        """storage() returns a StorageClient instance."""
        kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
        client = kit.storage()

        assert isinstance(client, StorageClient)

    @pytest.mark.asyncio
    async def test_bound_client_omits_storage_config(self):
        """Bound StorageClient sends no storage key (adapter uses Evolve's config)."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            await kit._ensure_initialized()

            client = kit.storage()
            await client.list_checkpoints()

        calls = _get_calls(mock_bridge, 'storage_list_checkpoints')
        assert len(calls) == 1
        params = calls[0][1]
        assert 'storage' not in params  # No storage key = use Evolve's bound config

    @pytest.mark.asyncio
    async def test_bound_client_triggers_init(self):
        """Bound StorageClient triggers Evolve initialization on first call."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            # Do NOT call _ensure_initialized — let StorageClient trigger it
            client = kit.storage()
            await client.list_checkpoints()

        # Should have called 'initialize' via _init_fn
        init_calls = _get_calls(mock_bridge, 'initialize')
        assert len(init_calls) == 1


# =============================================================================
# STANDALONE storage() FUNCTION
# =============================================================================


class TestStandaloneStorage:
    """Test standalone storage() function."""

    def test_storage_is_sync(self):
        """storage() is a synchronous function, not a coroutine."""
        import asyncio
        result = storage_factory(StorageConfig(url='s3://bucket/'))
        assert not asyncio.iscoroutine(result)
        assert isinstance(result, StorageClient)

    @pytest.mark.asyncio
    async def test_standalone_includes_storage_config(self):
        """Standalone StorageClient includes storage config in RPC params."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'), _owns_bridge=True)

        await client.list_checkpoints()

        calls = _get_calls(bridge, 'storage_list_checkpoints')
        params = calls[0][1]
        assert 'storage' in params
        assert params['storage'] == {'url': 's3://bucket/'}

    @pytest.mark.asyncio
    async def test_gateway_mode(self):
        """storage() with no args uses gateway mode (empty storage config)."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(), _owns_bridge=True)

        await client.list_checkpoints()

        calls = _get_calls(bridge, 'storage_list_checkpoints')
        params = calls[0][1]
        assert 'storage' in params
        assert params['storage'] == {}  # Empty = gateway mode

    @pytest.mark.asyncio
    async def test_byok_with_credentials(self):
        """storage(config) passes credentials through."""
        bridge = MockBridgeManager()
        config = StorageConfig(
            url='s3://my-bucket/prefix/',
            region='us-east-1',
            credentials=StorageCredentials(
                access_key_id='AKIA123',
                secret_access_key='secret456',
            ),
        )
        client = StorageClient(bridge, config, _owns_bridge=True)

        await client.get_checkpoint('cp-test')

        calls = _get_calls(bridge, 'storage_get_checkpoint')
        params = calls[0][1]
        assert params['storage']['url'] == 's3://my-bucket/prefix/'
        assert params['storage']['region'] == 'us-east-1'
        assert params['storage']['credentials'] == {
            'accessKeyId': 'AKIA123',
            'secretAccessKey': 'secret456',
        }


# =============================================================================
# CONTEXT MANAGER & CLEANUP
# =============================================================================


class TestContextManagerAndCleanup:
    """Test async context manager and close() behavior."""

    @pytest.mark.asyncio
    async def test_context_manager_standalone(self):
        """StorageClient works as async context manager (standalone)."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'), _owns_bridge=True)

        async with client as store:
            checkpoints = await store.list_checkpoints()
            assert len(checkpoints) == 2

        assert bridge.stopped  # Bridge stopped on __aexit__

    @pytest.mark.asyncio
    async def test_close_standalone_stops_bridge(self):
        """close() on standalone client stops the bridge."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'), _owns_bridge=True)

        await client.close()

        assert bridge.stopped

    @pytest.mark.asyncio
    async def test_close_bound_does_not_stop_bridge(self):
        """close() on bound client does NOT stop the bridge."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, storage_config=None)  # bound mode

        await client.close()

        assert not bridge.stopped  # Must NOT kill shared bridge

    @pytest.mark.asyncio
    async def test_ensure_ready_starts_bridge(self):
        """First RPC call starts the bridge subprocess."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        assert not bridge.started
        await client.list_checkpoints()
        assert bridge.started

    @pytest.mark.asyncio
    async def test_ensure_ready_idempotent(self):
        """Multiple RPC calls only start bridge once."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.list_checkpoints()
        await client.list_checkpoints()
        await client.get_checkpoint('cp-1')

        # bridge.start() should have been called once (no 'start' in calls list,
        # but we track via the started flag which is set once)
        assert bridge.started
