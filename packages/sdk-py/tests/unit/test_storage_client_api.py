"""
Unit tests for StorageClient, Evolve.storage(), and standalone storage().

Tests:
- StorageClient.list_checkpoints() delegates correctly and parses response
- StorageClient.get_checkpoint(id) returns CheckpointInfo
- StorageClient.download_checkpoint(id) returns path
- StorageClient.download_files(id) returns decoded FileMap
- StorageClient.download_files(id, files=[...]) passes filter
- StorageClient.download_files(id, glob=[...]) passes glob
- Evolve.storage() returns StorageClient, raises without storage config
- Evolve.storage().list_checkpoints() delegates with no storage config
- Standalone storage() creates client with own bridge
- Standalone storage(config) passes config through
"""

import pytest
from unittest.mock import patch

from evolve import Evolve, StorageConfig, StorageCredentials, CheckpointInfo, StorageClient
from evolve import storage as standalone_storage


# =============================================================================
# MOCK BRIDGE
# =============================================================================


class MockBridgeManager:
    """Async bridge mock with storage client RPC support."""

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
# STORAGE CLIENT — LIST CHECKPOINTS
# =============================================================================


class TestStorageClientListCheckpoints:
    """Test StorageClient.list_checkpoints()."""

    @pytest.mark.asyncio
    async def test_list_checkpoints_delegates_to_bridge(self):
        """list_checkpoints() calls storage_list_checkpoints with storage config."""
        bridge = MockBridgeManager()
        config = StorageConfig(url='s3://bucket/prefix/')
        client = StorageClient(bridge, config)

        checkpoints = await client.list_checkpoints(limit=10, tag='test-tag')

        calls = [c for c in bridge.calls if c[0] == 'storage_list_checkpoints']
        assert len(calls) == 1
        params = calls[0][1]
        assert params['storage'] == {'url': 's3://bucket/prefix/'}
        assert params['limit'] == 10
        assert params['tag'] == 'test-tag'

    @pytest.mark.asyncio
    async def test_list_checkpoints_parses_response(self):
        """list_checkpoints() returns parsed CheckpointInfo list."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        checkpoints = await client.list_checkpoints()

        assert len(checkpoints) == 2
        assert isinstance(checkpoints[0], CheckpointInfo)
        assert checkpoints[0].id == 'cp-2'
        assert checkpoints[0].comment == 'second'
        assert checkpoints[1].id == 'cp-1'
        assert checkpoints[1].size_bytes == 1024

    @pytest.mark.asyncio
    async def test_list_checkpoints_omits_none_params(self):
        """list_checkpoints() with no args only includes storage key."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.list_checkpoints()

        calls = [c for c in bridge.calls if c[0] == 'storage_list_checkpoints']
        params = calls[0][1]
        assert 'limit' not in params
        assert 'tag' not in params


# =============================================================================
# STORAGE CLIENT — GET CHECKPOINT
# =============================================================================


class TestStorageClientGetCheckpoint:
    """Test StorageClient.get_checkpoint()."""

    @pytest.mark.asyncio
    async def test_get_checkpoint_delegates_to_bridge(self):
        """get_checkpoint(id) calls storage_get_checkpoint with correct params."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        info = await client.get_checkpoint('cp-123')

        calls = [c for c in bridge.calls if c[0] == 'storage_get_checkpoint']
        assert len(calls) == 1
        assert calls[0][1]['id'] == 'cp-123'

    @pytest.mark.asyncio
    async def test_get_checkpoint_returns_full_metadata(self):
        """get_checkpoint() parses all fields correctly."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

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


# =============================================================================
# STORAGE CLIENT — DOWNLOAD CHECKPOINT
# =============================================================================


class TestStorageClientDownloadCheckpoint:
    """Test StorageClient.download_checkpoint()."""

    @pytest.mark.asyncio
    async def test_download_checkpoint_returns_path(self):
        """download_checkpoint() returns extracted directory path."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        path = await client.download_checkpoint('cp-123')

        assert path == '/tmp/evolve-extract-12345'

    @pytest.mark.asyncio
    async def test_download_checkpoint_passes_options(self):
        """download_checkpoint() passes to and extract options."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.download_checkpoint('cp-123', to='/my/dir', extract=False)

        calls = [c for c in bridge.calls if c[0] == 'storage_download_checkpoint']
        params = calls[0][1]
        assert params['id'] == 'cp-123'
        assert params['to'] == '/my/dir'
        assert params['extract'] is False

    @pytest.mark.asyncio
    async def test_download_checkpoint_omits_default_extract(self):
        """download_checkpoint() omits extract when True (default)."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.download_checkpoint('cp-123')

        calls = [c for c in bridge.calls if c[0] == 'storage_download_checkpoint']
        params = calls[0][1]
        assert 'extract' not in params


# =============================================================================
# STORAGE CLIENT — DOWNLOAD FILES
# =============================================================================


class TestStorageClientDownloadFiles:
    """Test StorageClient.download_files()."""

    @pytest.mark.asyncio
    async def test_download_files_returns_decoded_map(self):
        """download_files() decodes text and base64 files."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        files = await client.download_files('cp-123')

        assert 'workspace/data.txt' in files
        assert files['workspace/data.txt'] == 'hello world'
        assert 'workspace/image.png' in files
        assert isinstance(files['workspace/image.png'], bytes)

    @pytest.mark.asyncio
    async def test_download_files_passes_file_filter(self):
        """download_files(files=[...]) passes files filter."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.download_files('cp-123', files=['workspace/data.txt'])

        calls = [c for c in bridge.calls if c[0] == 'storage_download_files']
        params = calls[0][1]
        assert params['files'] == ['workspace/data.txt']

    @pytest.mark.asyncio
    async def test_download_files_passes_glob_filter(self):
        """download_files(glob=[...]) passes glob patterns."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.download_files('cp-123', glob=['workspace/*.txt'])

        calls = [c for c in bridge.calls if c[0] == 'storage_download_files']
        params = calls[0][1]
        assert params['glob'] == ['workspace/*.txt']

    @pytest.mark.asyncio
    async def test_download_files_passes_to_option(self):
        """download_files(to=...) passes to directory."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.download_files('cp-123', to='/output/dir')

        calls = [c for c in bridge.calls if c[0] == 'storage_download_files']
        params = calls[0][1]
        assert params['to'] == '/output/dir'

    @pytest.mark.asyncio
    async def test_download_files_latest_resolution(self):
        """download_files('latest') passes 'latest' as id."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'))

        await client.download_files('latest')

        calls = [c for c in bridge.calls if c[0] == 'storage_download_files']
        assert calls[0][1]['id'] == 'latest'


# =============================================================================
# EVOLVE.STORAGE() ACCESSOR
# =============================================================================


class TestEvolveStorageAccessor:
    """Test Evolve.storage() method."""

    def test_storage_raises_without_config(self):
        """storage() raises RuntimeError when storage not configured."""
        kit = Evolve()
        with pytest.raises(RuntimeError, match='Storage not configured'):
            kit.storage()

    def test_storage_returns_client(self):
        """storage() returns a StorageClient instance."""
        kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
        client = kit.storage()

        assert isinstance(client, StorageClient)

    @pytest.mark.asyncio
    async def test_storage_client_omits_storage_config(self):
        """Bound StorageClient sends no storage key (adapter uses Evolve's config)."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            await kit._ensure_initialized()

            client = kit.storage()
            await client.list_checkpoints()

        calls = [c for c in mock_bridge.calls if c[0] == 'storage_list_checkpoints']
        assert len(calls) == 1
        params = calls[0][1]
        assert 'storage' not in params  # No storage key = use Evolve's bound config


# =============================================================================
# STANDALONE storage() FUNCTION
# =============================================================================


class TestStandaloneStorage:
    """Test standalone storage() function."""

    @pytest.mark.asyncio
    async def test_storage_returns_client(self):
        """Standalone StorageClient includes storage config and delegates correctly."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'), _owns_bridge=True)

        checkpoints = await client.list_checkpoints()
        assert len(checkpoints) == 2

        calls = [c for c in bridge.calls if c[0] == 'storage_list_checkpoints']
        params = calls[0][1]
        assert 'storage' in params
        assert params['storage'] == {'url': 's3://bucket/'}

    @pytest.mark.asyncio
    async def test_storage_gateway_mode(self):
        """storage() with no args uses gateway mode (empty storage config)."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(), _owns_bridge=True)

        await client.list_checkpoints()

        calls = [c for c in bridge.calls if c[0] == 'storage_list_checkpoints']
        params = calls[0][1]
        assert 'storage' in params
        assert params['storage'] == {}  # Empty = gateway mode

    @pytest.mark.asyncio
    async def test_storage_client_context_manager(self):
        """StorageClient works as async context manager."""
        bridge = MockBridgeManager()
        client = StorageClient(bridge, StorageConfig(url='s3://bucket/'), _owns_bridge=True)

        async with client as store:
            checkpoints = await store.list_checkpoints()
            assert len(checkpoints) == 2

    @pytest.mark.asyncio
    async def test_storage_byok_with_credentials(self):
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

        calls = [c for c in bridge.calls if c[0] == 'storage_get_checkpoint']
        params = calls[0][1]
        assert params['storage']['url'] == 's3://my-bucket/prefix/'
        assert params['storage']['region'] == 'us-east-1'
        assert params['storage']['credentials'] == {
            'accessKeyId': 'AKIA123',
            'secretAccessKey': 'secret456',
        }
