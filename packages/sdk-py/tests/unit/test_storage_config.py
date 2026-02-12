"""
Unit tests for Storage / Checkpointing configuration and data types.

Tests:
- StorageConfig dataclass fields and to_dict() serialization
- StorageCredentials dataclass
- CheckpointInfo dataclass fields
- AgentResponse.checkpoint field
- Evolve constructor storage parameter
- Bridge initialization params include storage
- run() passes from_checkpoint and checkpoint_comment to bridge
- run() parses checkpoint from bridge response
- checkpoint() method delegates to bridge
- list_checkpoints() method delegates to bridge
"""

import pytest
from unittest.mock import patch

from evolve import Evolve, StorageConfig, StorageCredentials, CheckpointInfo
from evolve.config import StorageConfig as ConfigStorageConfig
from evolve.results import AgentResponse, CheckpointInfo as ResultCheckpointInfo


# =============================================================================
# STORAGE CONFIG DATACLASS
# =============================================================================


class TestStorageConfig:
    """Test StorageConfig dataclass fields and serialization."""

    def test_default_values(self):
        """All fields should default to None."""
        config = StorageConfig()

        assert config.url is None
        assert config.bucket is None
        assert config.prefix is None
        assert config.region is None
        assert config.endpoint is None
        assert config.credentials is None

    def test_byok_mode_config(self):
        """Test BYOK mode with S3 URL."""
        config = StorageConfig(
            url='s3://my-bucket/agents/',
            region='us-west-2',
        )

        assert config.url == 's3://my-bucket/agents/'
        assert config.region == 'us-west-2'

    def test_byok_with_credentials(self):
        """Test BYOK mode with explicit credentials."""
        creds = StorageCredentials(
            access_key_id='AKIA...',
            secret_access_key='secret...',
        )
        config = StorageConfig(
            url='s3://my-bucket/prefix/',
            region='us-east-1',
            credentials=creds,
        )

        assert config.credentials is not None
        assert config.credentials.access_key_id == 'AKIA...'
        assert config.credentials.secret_access_key == 'secret...'

    def test_r2_endpoint_config(self):
        """Test Cloudflare R2 config with custom endpoint."""
        config = StorageConfig(
            url='s3://my-r2-bucket/prefix/',
            endpoint='https://acct.r2.cloudflarestorage.com',
        )

        assert config.endpoint == 'https://acct.r2.cloudflarestorage.com'

    def test_to_dict_byok(self):
        """Test to_dict() for BYOK mode."""
        config = StorageConfig(
            url='s3://my-bucket/prefix/',
            region='us-west-2',
        )

        d = config.to_dict()
        assert d == {'url': 's3://my-bucket/prefix/', 'region': 'us-west-2'}

    def test_to_dict_with_credentials(self):
        """Test to_dict() includes credentials with camelCase keys."""
        config = StorageConfig(
            url='s3://bucket/prefix/',
            credentials=StorageCredentials(
                access_key_id='AKIA123',
                secret_access_key='secret456',
            ),
        )

        d = config.to_dict()
        assert d['credentials'] == {
            'accessKeyId': 'AKIA123',
            'secretAccessKey': 'secret456',
        }

    def test_to_dict_gateway_mode(self):
        """Test to_dict() for gateway mode (empty config)."""
        config = StorageConfig()
        d = config.to_dict()
        assert d == {}

    def test_to_dict_omits_none_values(self):
        """Test to_dict() omits None fields."""
        config = StorageConfig(url='s3://bucket/')
        d = config.to_dict()
        assert 'region' not in d
        assert 'endpoint' not in d
        assert 'credentials' not in d
        assert 'bucket' not in d
        assert 'prefix' not in d


# =============================================================================
# CHECKPOINT INFO DATACLASS
# =============================================================================


class TestCheckpointInfo:
    """Test CheckpointInfo dataclass fields."""

    def test_required_fields(self):
        """Test required fields."""
        info = CheckpointInfo(
            id='cp-123',
            hash='sha256-abc',
            tag='session-tag',
            timestamp='2026-01-15T10:00:00.000Z',
        )

        assert info.id == 'cp-123'
        assert info.hash == 'sha256-abc'
        assert info.tag == 'session-tag'
        assert info.timestamp == '2026-01-15T10:00:00.000Z'

    def test_optional_fields_default_none(self):
        """Test optional fields default to None."""
        info = CheckpointInfo(
            id='cp-123',
            hash='sha256-abc',
            tag='tag',
            timestamp='2026-01-15T10:00:00.000Z',
        )

        assert info.size_bytes is None
        assert info.agent_type is None
        assert info.model is None
        assert info.workspace_mode is None
        assert info.parent_id is None
        assert info.comment is None

    def test_all_fields(self):
        """Test all fields populated."""
        info = CheckpointInfo(
            id='cp-456',
            hash='sha256-def',
            tag='experiment-7-a3f8b2c1',
            timestamp='2026-01-15T12:00:00.000Z',
            size_bytes=1048576,
            agent_type='claude',
            model='opus',
            workspace_mode='knowledge',
            parent_id='cp-123',
            comment='before refactor',
        )

        assert info.size_bytes == 1048576
        assert info.agent_type == 'claude'
        assert info.model == 'opus'
        assert info.workspace_mode == 'knowledge'
        assert info.parent_id == 'cp-123'
        assert info.comment == 'before refactor'


# =============================================================================
# AGENT RESPONSE WITH CHECKPOINT
# =============================================================================


class TestAgentResponseCheckpoint:
    """Test AgentResponse.checkpoint field."""

    def test_checkpoint_defaults_none(self):
        """Checkpoint defaults to None for backward compatibility."""
        response = AgentResponse(
            sandbox_id='sb-123',
            exit_code=0,
            stdout='hello',
            stderr='',
        )

        assert response.checkpoint is None

    def test_checkpoint_populated(self):
        """Checkpoint can be populated."""
        cp = CheckpointInfo(
            id='cp-123',
            hash='sha256-abc',
            tag='tag',
            timestamp='2026-01-15T10:00:00.000Z',
            comment='test',
        )
        response = AgentResponse(
            sandbox_id='sb-123',
            exit_code=0,
            stdout='hello',
            stderr='',
            checkpoint=cp,
        )

        assert response.checkpoint is not None
        assert response.checkpoint.id == 'cp-123'
        assert response.checkpoint.comment == 'test'


# =============================================================================
# MOCK BRIDGE FOR RUNTIME TESTS
# =============================================================================


class MockBridgeManager:
    """Async bridge mock with storage/checkpoint support."""

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
        if method == 'run':
            return {
                'sandbox_id': 'sb-test',
                'exit_code': 0,
                'stdout': 'done',
                'stderr': '',
                'checkpoint': {
                    'id': 'cp-mock',
                    'hash': 'sha256-mock',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T10:00:00.000Z',
                    'size_bytes': 1024,
                    'agent_type': 'claude',
                    'model': 'opus',
                    'workspace_mode': 'knowledge',
                    'parent_id': None,
                    'comment': 'auto',
                },
            }
        if method == 'checkpoint':
            return {
                'id': 'cp-explicit',
                'hash': 'sha256-explicit',
                'tag': 'test-tag',
                'timestamp': '2026-01-15T11:00:00.000Z',
                'comment': params.get('comment') if params else None,
            }
        if method == 'list_checkpoints':
            return [
                {
                    'id': 'cp-2',
                    'hash': 'sha256-2',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T11:00:00.000Z',
                },
                {
                    'id': 'cp-1',
                    'hash': 'sha256-1',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T10:00:00.000Z',
                },
            ]
        return {'status': 'ok'}


# =============================================================================
# EVOLVE CONSTRUCTOR + INITIALIZATION
# =============================================================================


class TestEvolveStorageInit:
    """Test Evolve constructor and bridge initialization with storage."""

    @pytest.mark.asyncio
    async def test_storage_passed_to_bridge_init(self):
        """Storage config should be passed in initialize params."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(
                storage=StorageConfig(
                    url='s3://test-bucket/prefix/',
                    region='us-west-2',
                ),
            )
            await kit._ensure_initialized()

        init_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
        assert len(init_calls) == 1
        params = init_calls[0][1]
        assert 'storage' in params
        assert params['storage'] == {'url': 's3://test-bucket/prefix/', 'region': 'us-west-2'}

    @pytest.mark.asyncio
    async def test_no_storage_omits_key(self):
        """Without storage, params should not include storage key."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve()
            await kit._ensure_initialized()

        init_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
        params = init_calls[0][1]
        assert 'storage' not in params


# =============================================================================
# RUN WITH CHECKPOINT PARAMS
# =============================================================================


class TestRunCheckpointParams:
    """Test run() passes checkpoint params and parses response."""

    @pytest.mark.asyncio
    async def test_run_passes_from_checkpoint(self):
        """run(from_checkpoint=...) sends 'from' in RPC params."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(prompt='Continue', from_checkpoint='cp-123')

        run_calls = [c for c in mock_bridge.calls if c[0] == 'run']
        assert len(run_calls) == 1
        params = run_calls[0][1]
        assert params['from'] == 'cp-123'

    @pytest.mark.asyncio
    async def test_run_passes_from_latest(self):
        """run(from_checkpoint='latest') sends 'from': 'latest'."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(prompt='Continue', from_checkpoint='latest')

        run_calls = [c for c in mock_bridge.calls if c[0] == 'run']
        params = run_calls[0][1]
        assert params['from'] == 'latest'

    @pytest.mark.asyncio
    async def test_run_passes_checkpoint_comment(self):
        """run(checkpoint_comment=...) sends 'checkpoint_comment' in RPC params."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(prompt='Build', checkpoint_comment='initial setup')

        run_calls = [c for c in mock_bridge.calls if c[0] == 'run']
        params = run_calls[0][1]
        assert params['checkpoint_comment'] == 'initial setup'

    @pytest.mark.asyncio
    async def test_run_omits_none_checkpoint_params(self):
        """run() without checkpoint params omits from/checkpoint_comment."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve()
            result = await kit.run(prompt='Hello')

        run_calls = [c for c in mock_bridge.calls if c[0] == 'run']
        params = run_calls[0][1]
        assert 'from' not in params
        assert 'checkpoint_comment' not in params

    @pytest.mark.asyncio
    async def test_run_parses_checkpoint_from_response(self):
        """run() parses checkpoint from bridge response."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(prompt='Build')

        assert result.checkpoint is not None
        assert result.checkpoint.id == 'cp-mock'
        assert result.checkpoint.hash == 'sha256-mock'
        assert result.checkpoint.tag == 'test-tag'
        assert result.checkpoint.size_bytes == 1024
        assert result.checkpoint.agent_type == 'claude'
        assert result.checkpoint.model == 'opus'
        assert result.checkpoint.workspace_mode == 'knowledge'
        assert result.checkpoint.comment == 'auto'


# =============================================================================
# CHECKPOINT METHOD
# =============================================================================


class TestCheckpointMethod:
    """Test Evolve.checkpoint() method."""

    @pytest.mark.asyncio
    async def test_checkpoint_delegates_to_bridge(self):
        """checkpoint() calls bridge with 'checkpoint' method."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            info = await kit.checkpoint(comment='manual snapshot')

        cp_calls = [c for c in mock_bridge.calls if c[0] == 'checkpoint']
        assert len(cp_calls) == 1
        assert cp_calls[0][1] == {'comment': 'manual snapshot'}

        assert info.id == 'cp-explicit'
        assert info.hash == 'sha256-explicit'
        assert info.comment == 'manual snapshot'

    @pytest.mark.asyncio
    async def test_checkpoint_without_comment(self):
        """checkpoint() without comment sends empty params."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            info = await kit.checkpoint()

        cp_calls = [c for c in mock_bridge.calls if c[0] == 'checkpoint']
        assert len(cp_calls) == 1
        assert cp_calls[0][1] == {}


# =============================================================================
# LIST CHECKPOINTS METHOD
# =============================================================================


class TestListCheckpointsMethod:
    """Test Evolve.list_checkpoints() method."""

    @pytest.mark.asyncio
    async def test_list_checkpoints_delegates_to_bridge(self):
        """list_checkpoints() calls bridge with 'list_checkpoints' method."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            checkpoints = await kit.list_checkpoints(limit=10, tag='test-tag')

        lc_calls = [c for c in mock_bridge.calls if c[0] == 'list_checkpoints']
        assert len(lc_calls) == 1
        assert lc_calls[0][1] == {'limit': 10, 'tag': 'test-tag'}

        assert len(checkpoints) == 2
        assert checkpoints[0].id == 'cp-2'
        assert checkpoints[1].id == 'cp-1'

    @pytest.mark.asyncio
    async def test_list_checkpoints_no_params(self):
        """list_checkpoints() without params sends empty dict."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            checkpoints = await kit.list_checkpoints()

        lc_calls = [c for c in mock_bridge.calls if c[0] == 'list_checkpoints']
        assert lc_calls[0][1] == {}


# =============================================================================
# PARSE CHECKPOINT HELPER
# =============================================================================


class TestParseCheckpoint:
    """Test Evolve._parse_checkpoint() static method."""

    def test_parse_none(self):
        """None input returns None."""
        assert Evolve._parse_checkpoint(None) is None

    def test_parse_empty_dict(self):
        """Empty dict returns None."""
        assert Evolve._parse_checkpoint({}) is None

    def test_parse_full_checkpoint(self):
        """Full checkpoint dict is parsed correctly."""
        data = {
            'id': 'cp-test',
            'hash': 'sha256-test',
            'tag': 'tag-test',
            'timestamp': '2026-01-15T10:00:00.000Z',
            'size_bytes': 2048,
            'agent_type': 'claude',
            'model': 'opus',
            'workspace_mode': 'knowledge',
            'parent_id': 'cp-parent',
            'comment': 'test comment',
        }
        info = Evolve._parse_checkpoint(data)

        assert info is not None
        assert info.id == 'cp-test'
        assert info.hash == 'sha256-test'
        assert info.tag == 'tag-test'
        assert info.timestamp == '2026-01-15T10:00:00.000Z'
        assert info.size_bytes == 2048
        assert info.agent_type == 'claude'
        assert info.model == 'opus'
        assert info.workspace_mode == 'knowledge'
        assert info.parent_id == 'cp-parent'
        assert info.comment == 'test comment'

    def test_parse_minimal_checkpoint(self):
        """Minimal checkpoint (only required fields)."""
        data = {
            'id': 'cp-min',
            'hash': 'sha256-min',
            'tag': 'tag-min',
            'timestamp': '2026-01-15T10:00:00.000Z',
        }
        info = Evolve._parse_checkpoint(data)

        assert info is not None
        assert info.id == 'cp-min'
        assert info.size_bytes is None
        assert info.parent_id is None
        assert info.comment is None


# =============================================================================
# STANDALONE list_checkpoints() GATEWAY MODE
# =============================================================================


class TestStandaloneListCheckpoints:
    """Test standalone list_checkpoints() function."""

    @pytest.mark.asyncio
    async def test_gateway_mode_sends_empty_storage(self):
        """list_checkpoints(storage=None) should send storage: {} (gateway mode)."""
        from evolve import list_checkpoints as standalone_list_checkpoints

        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            checkpoints = await standalone_list_checkpoints()

        # Verify initialize was called with storage: {} (not omitted)
        init_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
        assert len(init_calls) == 1
        params = init_calls[0][1]
        assert 'storage' in params, 'storage key must be present for gateway mode'
        assert params['storage'] == {}, 'storage must be empty dict for gateway mode'

    @pytest.mark.asyncio
    async def test_byok_mode_passes_storage(self):
        """list_checkpoints(storage=StorageConfig(url=...)) passes config through."""
        from evolve import list_checkpoints as standalone_list_checkpoints

        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            checkpoints = await standalone_list_checkpoints(
                storage=StorageConfig(url='s3://my-bucket/prefix/', region='us-east-1'),
                limit=5,
            )

        init_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
        params = init_calls[0][1]
        assert params['storage'] == {'url': 's3://my-bucket/prefix/', 'region': 'us-east-1'}

        lc_calls = [c for c in mock_bridge.calls if c[0] == 'list_checkpoints']
        assert lc_calls[0][1] == {'limit': 5}


# =============================================================================
# FROM_CHECKPOINT + SANDBOX_ID MUTUAL EXCLUSIVITY
# =============================================================================


class TestFromCheckpointWithSessionError:
    """Test from_checkpoint + sandbox_id mutual exclusivity."""

    @pytest.mark.asyncio
    async def test_from_checkpoint_with_sandbox_id_raises(self):
        """run(from_checkpoint=...) on Evolve(sandbox_id=...) should raise an error.

        Mirrors TS test: checkpoint-errors.test.ts 'Evolve from + withSession mutual exclusivity'.
        The guard is enforced in the TS bridge — the bridge should return an error
        when both from_checkpoint and sandbox_id are set.
        """
        mock_bridge = MockBridgeManager()

        # Override call to simulate the TS bridge error for from + withSession
        original_call = mock_bridge.call

        async def error_on_run(method, params=None, timeout_s=None):
            if method == 'run' and params and params.get('from'):
                raise Exception(
                    'Cannot use "from" (checkpoint restore) together with withSession() — '
                    'they are mutually exclusive.'
                )
            return await original_call(method, params, timeout_s)

        mock_bridge.call = error_on_run

        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(
                storage=StorageConfig(url='s3://bucket/'),
                sandbox_id='existing-sandbox-id',
            )

            with pytest.raises(Exception, match='withSession'):
                await kit.run(prompt='test', from_checkpoint='cp-123')

    @pytest.mark.asyncio
    async def test_from_checkpoint_without_sandbox_id_succeeds(self):
        """run(from_checkpoint=...) without sandbox_id should succeed normally."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(prompt='Continue', from_checkpoint='cp-123')

        assert result.exit_code == 0
        run_calls = [c for c in mock_bridge.calls if c[0] == 'run']
        assert run_calls[0][1]['from'] == 'cp-123'
