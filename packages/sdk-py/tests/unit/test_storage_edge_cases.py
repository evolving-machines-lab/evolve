"""
Unit tests for Storage / Checkpointing edge cases.

Tests edge cases not covered by test_storage_config.py:
  1. limit+tag interaction — verifies both are passed to bridge
  2. Tag filter passed in list_checkpoints params
  3. from_checkpoint='latest' + sandbox_id mutual exclusivity
  4. Auto-checkpoint not present on non-zero exit (bridge behavior)
  5. Corrupted checkpoint response handling (_parse_checkpoint)
  6. list_checkpoints with tag parameter
  7. checkpoint_comment + from_checkpoint together
"""

import pytest
from unittest.mock import patch

from evolve import Evolve, StorageConfig, CheckpointInfo
from evolve.results import AgentResponse
from evolve.utils import _parse_checkpoint


# =============================================================================
# MOCK BRIDGE
# =============================================================================


class MockBridgeManager:
    """Async bridge mock with configurable responses."""

    def __init__(self, run_response=None, list_response=None):
        self.calls = []
        self.callbacks = {}
        self._run_response = run_response
        self._list_response = list_response

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
            if self._run_response is not None:
                return self._run_response
            return {
                'sandbox_id': 'sb-test',
                'exit_code': 0,
                'stdout': 'done',
                'stderr': '',
                'checkpoint': {
                    'id': 'cp-auto',
                    'hash': 'sha256-auto',
                    'tag': 'test-tag',
                    'timestamp': '2026-01-15T10:00:00.000Z',
                    'size_bytes': 1024,
                    'agent_type': 'claude',
                    'model': 'opus',
                    'workspace_mode': 'knowledge',
                    'parent_id': None,
                    'comment': None,
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
        if method in ('list_checkpoints', 'storage_list_checkpoints'):
            if self._list_response is not None:
                return self._list_response
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
                    'tag': 'other-tag',
                    'timestamp': '2026-01-15T10:00:00.000Z',
                },
            ]
        return {'status': 'ok'}


# =============================================================================
# TEST 1: limit + tag both passed to bridge
# =============================================================================


class TestLimitTagInteraction:
    """Verify limit and tag are both sent in the bridge call."""

    @pytest.mark.asyncio
    async def test_list_checkpoints_sends_both_limit_and_tag(self):
        """list_checkpoints(limit=5, tag='x') sends both params."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            await kit.list_checkpoints(limit=5, tag='session-A')

        lc_calls = [c for c in mock_bridge.calls if c[0] == 'list_checkpoints']
        assert len(lc_calls) == 1
        params = lc_calls[0][1]
        assert params == {'limit': 5, 'tag': 'session-A'}

    @pytest.mark.asyncio
    async def test_list_checkpoints_tag_only(self):
        """list_checkpoints(tag='x') sends tag without limit."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            await kit.list_checkpoints(tag='session-B')

        lc_calls = [c for c in mock_bridge.calls if c[0] == 'list_checkpoints']
        params = lc_calls[0][1]
        assert params == {'tag': 'session-B'}
        assert 'limit' not in params


# =============================================================================
# TEST 2: from_checkpoint='latest' + sandbox_id mutual exclusivity
# =============================================================================


class TestFromLatestMutualExclusivity:
    """Test from_checkpoint='latest' + sandbox_id throws error."""

    @pytest.mark.asyncio
    async def test_from_latest_with_sandbox_id_raises(self):
        """from_checkpoint='latest' with sandbox_id should fail."""
        mock_bridge = MockBridgeManager()

        original_call = mock_bridge.call

        async def error_on_run(method, params=None, timeout_s=None):
            if method == 'run' and params and params.get('from'):
                if 'sandbox_id' in [c[1].get('sandbox_id', '') for c in mock_bridge.calls if c[0] == 'initialize']:
                    raise Exception(
                        'Cannot use "from" (checkpoint restore) together with withSession() -- '
                        'they are mutually exclusive.'
                    )
                # Also check if sandbox_id was passed at init
                init_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
                if init_calls and init_calls[0][1].get('sandbox_id'):
                    raise Exception(
                        'Cannot use "from" (checkpoint restore) together with withSession() -- '
                        'they are mutually exclusive.'
                    )
            return await original_call(method, params, timeout_s)

        mock_bridge.call = error_on_run

        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(
                storage=StorageConfig(url='s3://bucket/'),
                sandbox_id='existing-sandbox',
            )

            with pytest.raises(Exception, match='mutually exclusive'):
                await kit.run(prompt='test', from_checkpoint='latest')


# =============================================================================
# TEST 3: Auto-checkpoint not present when run fails
# =============================================================================


class TestAutoCheckpointOnFailure:
    """Verify no checkpoint when run exits non-zero."""

    @pytest.mark.asyncio
    async def test_no_checkpoint_on_nonzero_exit(self):
        """Bridge response with exit_code != 0 should have checkpoint=None."""
        mock_bridge = MockBridgeManager(run_response={
            'sandbox_id': 'sb-test',
            'exit_code': 1,
            'stdout': 'error output',
            'stderr': 'something went wrong',
            'checkpoint': None,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(prompt='fail')

        assert result.exit_code == 1
        assert result.checkpoint is None


# =============================================================================
# TEST 4: _parse_checkpoint handles missing/extra fields gracefully
# =============================================================================


class TestParseCheckpointEdgeCases:
    """Test edge cases in _parse_checkpoint."""

    def test_parse_with_extra_unknown_fields(self):
        """Extra fields from bridge are silently ignored."""
        data = {
            'id': 'cp-extra',
            'hash': 'sha256-extra',
            'tag': 'tag-extra',
            'timestamp': '2026-01-15T10:00:00.000Z',
            'unknown_field': 'ignored',
            'another_field': 42,
        }
        info = _parse_checkpoint(data)

        assert info is not None
        assert info.id == 'cp-extra'
        # Should not have extra fields (dataclass won't accept them)
        assert not hasattr(info, 'unknown_field')

    def test_parse_with_null_optional_fields(self):
        """Explicit None values for optional fields are handled."""
        data = {
            'id': 'cp-nulls',
            'hash': 'sha256-nulls',
            'tag': 'tag-nulls',
            'timestamp': '2026-01-15T10:00:00.000Z',
            'size_bytes': None,
            'agent_type': None,
            'model': None,
            'workspace_mode': None,
            'parent_id': None,
            'comment': None,
        }
        info = _parse_checkpoint(data)

        assert info is not None
        assert info.size_bytes is None
        assert info.parent_id is None
        assert info.comment is None

    def test_parse_missing_required_field_raises(self):
        """Missing required field (id) raises KeyError."""
        data = {
            # 'id' is missing
            'hash': 'sha256-bad',
            'tag': 'tag-bad',
            'timestamp': '2026-01-15T10:00:00.000Z',
        }
        with pytest.raises(KeyError):
            _parse_checkpoint(data)


# =============================================================================
# TEST 5: checkpoint_comment + from_checkpoint together
# =============================================================================


class TestCheckpointCommentWithRestore:
    """Test that both from_checkpoint and checkpoint_comment can be sent."""

    @pytest.mark.asyncio
    async def test_both_from_and_comment_sent(self):
        """run() with both from_checkpoint and checkpoint_comment sends both."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            result = await kit.run(
                prompt='Continue work',
                from_checkpoint='cp-123',
                checkpoint_comment='resumed from cp-123',
            )

        run_calls = [c for c in mock_bridge.calls if c[0] == 'run']
        params = run_calls[0][1]
        assert params['from'] == 'cp-123'
        assert params['checkpoint_comment'] == 'resumed from cp-123'

        # Verify checkpoint is still parsed
        assert result.checkpoint is not None
        assert result.checkpoint.id == 'cp-auto'


# =============================================================================
# TEST 6: list_checkpoints returns parsed CheckpointInfo objects
# =============================================================================


class TestListCheckpointsParsing:
    """Verify list_checkpoints returns properly parsed objects."""

    @pytest.mark.asyncio
    async def test_list_returns_checkpoint_info_objects(self):
        """Each item in list should be a CheckpointInfo dataclass."""
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            checkpoints = await kit.list_checkpoints()

        assert len(checkpoints) == 2
        for cp in checkpoints:
            assert isinstance(cp, CheckpointInfo)
        assert checkpoints[0].id == 'cp-2'
        assert checkpoints[1].id == 'cp-1'

    @pytest.mark.asyncio
    async def test_list_empty_response(self):
        """Empty list from bridge returns empty list."""
        mock_bridge = MockBridgeManager(list_response=[])
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve(storage=StorageConfig(url='s3://bucket/'))
            checkpoints = await kit.list_checkpoints()

        assert checkpoints == []


# =============================================================================
# TEST 7: standalone list_checkpoints with tag
# =============================================================================


class TestStandaloneListWithTag:
    """Test standalone list_checkpoints passes tag parameter."""

    @pytest.mark.asyncio
    async def test_standalone_passes_tag(self):
        """Standalone list_checkpoints(tag=...) sends tag in RPC params."""
        from evolve import list_checkpoints as standalone_list_checkpoints

        mock_bridge = MockBridgeManager()
        with patch('evolve.bridge.BridgeManager', return_value=mock_bridge):
            await standalone_list_checkpoints(
                storage=StorageConfig(url='s3://bucket/'),
                tag='my-tag',
                limit=3,
            )

        rpc_calls = [c for c in mock_bridge.calls if c[0] == 'storage_list_checkpoints']
        assert len(rpc_calls) == 1
        params = rpc_calls[0][1]
        assert params.get('tag') == 'my-tag'
        assert params.get('limit') == 3
