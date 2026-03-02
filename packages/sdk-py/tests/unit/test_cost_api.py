"""
Unit tests for Cost API — Python SDK parity with TypeScript SDK.

Tests mirror packages/sdk-ts/tests/unit/cost-api.test.ts:
- RunCost / SessionCost dataclass fields and defaults
- AgentResponse.run_id field (present for run(), None for execute_command())
- get_session_cost() delegates to bridge and parses response
- get_run_cost(run_id=...) delegates with run_id param
- get_run_cost(index=...) delegates with index param
- _parse_run_cost() handles all fields
- _parse_session_cost() handles nested runs
- run() passes run_id from bridge response
- execute_command() has no run_id
"""

import pytest
from unittest.mock import patch

from evolve import Evolve, RunCost, SessionCost
from evolve.results import AgentResponse


# =============================================================================
# SAMPLE DATA (matches TS test fixtures)
# =============================================================================

SAMPLE_RUN_COST = {
    'run_id': 'run-abc-123',
    'index': 1,
    'cost': 0.4200,
    'tokens': {'prompt': 100, 'completion': 50},
    'model': 'claude-opus-4-6',
    'requests': 2,
    'as_of': '2026-02-25T00:00:00.000Z',
    'is_complete': True,
    'truncated': False,
}

SAMPLE_SESSION_COST = {
    'session_tag': 'evolve-prev-session',
    'total_cost': 1.2345,
    'total_tokens': {'prompt': 200, 'completion': 100},
    'runs': [
        {
            'run_id': 'run-1',
            'index': 1,
            'cost': 0.4,
            'tokens': {'prompt': 100, 'completion': 50},
            'model': 'claude-sonnet-4-5-20250929',
            'requests': 1,
            'as_of': '2026-02-25T00:00:00.000Z',
            'is_complete': True,
            'truncated': False,
        },
        {
            'run_id': 'run-2',
            'index': 2,
            'cost': 0.8345,
            'tokens': {'prompt': 100, 'completion': 50},
            'model': 'claude-opus-4-6',
            'requests': 3,
            'as_of': '2026-02-25T00:00:00.000Z',
            'is_complete': True,
            'truncated': False,
        },
    ],
    'as_of': '2026-02-25T00:00:00.000Z',
    'is_complete': True,
    'truncated': False,
}


# =============================================================================
# MOCK BRIDGE
# =============================================================================


class MockBridgeManager:
    """Async bridge mock with cost support."""

    def __init__(self, responses=None):
        self.calls = []
        self.callbacks = {}
        self._responses = responses or {}

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
                'run_id': 'run-uuid-from-bridge',
                'exit_code': 0,
                'stdout': 'done',
                'stderr': '',
            }
        if method == 'execute_command':
            return {
                'sandbox_id': 'sb-test',
                'exit_code': 0,
                'stdout': 'hello',
                'stderr': '',
            }
        if method == 'kill':
            return {'status': 'ok'}
        if method in self._responses:
            resp = self._responses[method]
            if callable(resp):
                return resp(params)
            return resp
        return {'status': 'ok'}


# =============================================================================
# RUNCOST DATACLASS
# =============================================================================


class TestRunCostDataclass:
    """Test RunCost dataclass fields — mirrors TS SDK RunCost interface."""

    def test_all_fields(self):
        """All fields populated correctly."""
        rc = RunCost(
            run_id='run-abc',
            index=1,
            cost=0.42,
            tokens={'prompt': 100, 'completion': 50},
            model='claude-opus-4-6',
            requests=2,
            as_of='2026-02-25T00:00:00.000Z',
            is_complete=True,
            truncated=False,
        )
        assert rc.run_id == 'run-abc'
        assert rc.index == 1
        assert rc.cost == 0.42
        assert rc.tokens == {'prompt': 100, 'completion': 50}
        assert rc.model == 'claude-opus-4-6'
        assert rc.requests == 2
        assert rc.as_of == '2026-02-25T00:00:00.000Z'
        assert rc.is_complete is True
        assert rc.truncated is False

    def test_field_types(self):
        """Fields have correct Python types matching TS interface."""
        rc = RunCost(**SAMPLE_RUN_COST)
        assert isinstance(rc.run_id, str)
        assert isinstance(rc.index, int)
        assert isinstance(rc.cost, float)
        assert isinstance(rc.tokens, dict)
        assert isinstance(rc.model, str)
        assert isinstance(rc.requests, int)
        assert isinstance(rc.as_of, str)
        assert isinstance(rc.is_complete, bool)
        assert isinstance(rc.truncated, bool)


# =============================================================================
# SESSIONCOST DATACLASS
# =============================================================================


class TestSessionCostDataclass:
    """Test SessionCost dataclass fields — mirrors TS SDK SessionCost interface."""

    def test_all_fields(self):
        """All fields populated correctly."""
        runs = [RunCost(**SAMPLE_RUN_COST)]
        sc = SessionCost(
            session_tag='evolve-session-tag',
            total_cost=1.2345,
            total_tokens={'prompt': 200, 'completion': 100},
            runs=runs,
            as_of='2026-02-25T00:00:00.000Z',
            is_complete=True,
            truncated=False,
        )
        assert sc.session_tag == 'evolve-session-tag'
        assert sc.total_cost == 1.2345
        assert sc.total_tokens == {'prompt': 200, 'completion': 100}
        assert len(sc.runs) == 1
        assert sc.runs[0].run_id == 'run-abc-123'
        assert sc.as_of == '2026-02-25T00:00:00.000Z'
        assert sc.is_complete is True
        assert sc.truncated is False

    def test_empty_runs(self):
        """Session with no runs (session just started)."""
        sc = SessionCost(
            session_tag='evolve-empty',
            total_cost=0.0,
            total_tokens={'prompt': 0, 'completion': 0},
            runs=[],
            as_of='2026-02-25T00:00:00.000Z',
            is_complete=False,
            truncated=False,
        )
        assert sc.total_cost == 0.0
        assert len(sc.runs) == 0
        assert sc.is_complete is False


# =============================================================================
# AGENTRESPONSE.RUN_ID FIELD
# =============================================================================


class TestAgentResponseRunId:
    """Test AgentResponse.run_id field — mirrors TS SDK AgentResponse.runId."""

    def test_run_id_defaults_none(self):
        """run_id defaults to None (backward compat for execute_command())."""
        response = AgentResponse(
            sandbox_id='sb-123',
            exit_code=0,
            stdout='hello',
            stderr='',
        )
        assert response.run_id is None

    def test_run_id_populated(self):
        """run_id can be set."""
        response = AgentResponse(
            sandbox_id='sb-123',
            exit_code=0,
            stdout='hello',
            stderr='',
            run_id='run-uuid-123',
        )
        assert response.run_id == 'run-uuid-123'

    @pytest.mark.asyncio
    async def test_run_returns_run_id(self):
        """run() parses run_id from bridge response."""
        mock = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            result = await kit.run(prompt='test')

        assert result.run_id == 'run-uuid-from-bridge'

    @pytest.mark.asyncio
    async def test_execute_command_has_no_run_id(self):
        """execute_command() returns None for run_id (no cost attribution)."""
        mock = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            result = await kit.execute_command(command='echo hello')

        assert result.run_id is None


# =============================================================================
# PARSE HELPERS
# =============================================================================


class TestCostParsers:
    """Test _parse_run_cost() and _parse_session_cost() static/class methods."""

    def test_parse_run_cost(self):
        """_parse_run_cost() maps all bridge response fields."""
        rc = Evolve._parse_run_cost(SAMPLE_RUN_COST)
        assert isinstance(rc, RunCost)
        assert rc.run_id == 'run-abc-123'
        assert rc.index == 1
        assert rc.cost == 0.42
        assert rc.tokens == {'prompt': 100, 'completion': 50}
        assert rc.model == 'claude-opus-4-6'
        assert rc.requests == 2
        assert rc.as_of == '2026-02-25T00:00:00.000Z'
        assert rc.is_complete is True
        assert rc.truncated is False

    def test_parse_session_cost(self):
        """_parse_session_cost() maps session fields and nested runs."""
        sc = Evolve._parse_session_cost(SAMPLE_SESSION_COST)
        assert isinstance(sc, SessionCost)
        assert sc.session_tag == 'evolve-prev-session'
        assert sc.total_cost == 1.2345
        assert sc.total_tokens == {'prompt': 200, 'completion': 100}
        assert sc.is_complete is True
        assert sc.truncated is False
        assert len(sc.runs) == 2
        assert sc.runs[0].run_id == 'run-1'
        assert sc.runs[0].model == 'claude-sonnet-4-5-20250929'
        assert sc.runs[1].run_id == 'run-2'
        assert sc.runs[1].model == 'claude-opus-4-6'
        assert sc.runs[1].cost == 0.8345

    def test_parse_session_cost_empty_runs(self):
        """_parse_session_cost() handles empty runs list."""
        data = {
            'session_tag': 'evolve-empty',
            'total_cost': 0.0,
            'total_tokens': {'prompt': 0, 'completion': 0},
            'runs': [],
            'as_of': '2026-02-25T00:00:00.000Z',
            'is_complete': False,
            'truncated': False,
        }
        sc = Evolve._parse_session_cost(data)
        assert sc.total_cost == 0.0
        assert len(sc.runs) == 0

    def test_parse_session_cost_missing_runs_key(self):
        """_parse_session_cost() defaults to empty list when 'runs' key is missing."""
        data = {
            'session_tag': 'evolve-no-runs',
            'total_cost': 0.0,
            'total_tokens': {'prompt': 0, 'completion': 0},
            'as_of': '2026-02-25T00:00:00.000Z',
            'is_complete': False,
            'truncated': False,
        }
        sc = Evolve._parse_session_cost(data)
        assert len(sc.runs) == 0


# =============================================================================
# GET_SESSION_COST() METHOD
# =============================================================================


class TestGetSessionCost:
    """Test Evolve.get_session_cost() — mirrors TS getSessionCost()."""

    @pytest.mark.asyncio
    async def test_delegates_to_bridge(self):
        """get_session_cost() calls bridge with 'get_session_cost' method."""
        mock = MockBridgeManager(responses={
            'get_session_cost': SAMPLE_SESSION_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            sc = await kit.get_session_cost()

        cost_calls = [c for c in mock.calls if c[0] == 'get_session_cost']
        assert len(cost_calls) == 1
        # No params needed
        assert cost_calls[0][1] is None

        assert isinstance(sc, SessionCost)
        assert sc.session_tag == 'evolve-prev-session'
        assert sc.total_cost == 1.2345
        assert len(sc.runs) == 2

    @pytest.mark.asyncio
    async def test_returns_session_cost_type(self):
        """Return type is SessionCost with RunCost items."""
        mock = MockBridgeManager(responses={
            'get_session_cost': SAMPLE_SESSION_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            sc = await kit.get_session_cost()

        assert isinstance(sc, SessionCost)
        for run in sc.runs:
            assert isinstance(run, RunCost)

    @pytest.mark.asyncio
    async def test_requires_initialization(self):
        """get_session_cost() calls _ensure_initialized() first."""
        mock = MockBridgeManager(responses={
            'get_session_cost': SAMPLE_SESSION_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            assert not kit._initialized
            await kit.get_session_cost()
            assert kit._initialized

        init_calls = [c for c in mock.calls if c[0] == 'initialize']
        assert len(init_calls) == 1


# =============================================================================
# GET_RUN_COST() METHOD
# =============================================================================


class TestGetRunCost:
    """Test Evolve.get_run_cost() — mirrors TS getRunCost()."""

    @pytest.mark.asyncio
    async def test_by_run_id(self):
        """get_run_cost(run_id=...) passes run_id param to bridge."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            rc = await kit.get_run_cost(run_id='run-abc-123')

        cost_calls = [c for c in mock.calls if c[0] == 'get_run_cost']
        assert len(cost_calls) == 1
        assert cost_calls[0][1] == {'run_id': 'run-abc-123'}

        assert isinstance(rc, RunCost)
        assert rc.run_id == 'run-abc-123'
        assert rc.cost == 0.42

    @pytest.mark.asyncio
    async def test_by_positive_index(self):
        """get_run_cost(index=2) passes index param to bridge."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            rc = await kit.get_run_cost(index=2)

        cost_calls = [c for c in mock.calls if c[0] == 'get_run_cost']
        assert cost_calls[0][1] == {'index': 2}

    @pytest.mark.asyncio
    async def test_by_negative_index(self):
        """get_run_cost(index=-1) passes negative index to bridge (last run)."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            rc = await kit.get_run_cost(index=-1)

        cost_calls = [c for c in mock.calls if c[0] == 'get_run_cost']
        assert cost_calls[0][1] == {'index': -1}

    @pytest.mark.asyncio
    async def test_returns_run_cost_type(self):
        """Return type is RunCost."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            rc = await kit.get_run_cost(run_id='run-abc-123')

        assert isinstance(rc, RunCost)

    @pytest.mark.asyncio
    async def test_keyword_only_args(self):
        """get_run_cost() requires keyword args (no positional)."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            # This should raise TypeError — run_id and index are keyword-only
            with pytest.raises(TypeError):
                await kit.get_run_cost('run-abc-123')  # type: ignore[misc]

    @pytest.mark.asyncio
    async def test_no_args_raises_value_error(self):
        """get_run_cost() with no args raises ValueError (must specify one)."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            with pytest.raises(ValueError, match='Specify either run_id or index'):
                await kit.get_run_cost()

    @pytest.mark.asyncio
    async def test_both_args_raises_value_error(self):
        """get_run_cost(run_id=..., index=...) raises ValueError (pick one)."""
        mock = MockBridgeManager(responses={
            'get_run_cost': SAMPLE_RUN_COST,
        })
        with patch('evolve.agent.BridgeManager', return_value=mock):
            kit = Evolve()
            with pytest.raises(ValueError, match='Specify run_id or index, not both'):
                await kit.get_run_cost(run_id='run-abc', index=1)


# =============================================================================
# TS ↔ PYTHON API SURFACE PARITY
# =============================================================================


class TestApiSurfaceParity:
    """Verify Python SDK cost API surface matches TypeScript SDK exactly.

    Evidence: sdk-ts/src/evolve.ts lines 746-763, sdk-ts/src/types.ts lines 440-502
    """

    def test_evolve_has_get_session_cost(self):
        """Evolve class has get_session_cost method."""
        assert hasattr(Evolve, 'get_session_cost')
        assert callable(getattr(Evolve, 'get_session_cost'))

    def test_evolve_has_get_run_cost(self):
        """Evolve class has get_run_cost method."""
        assert hasattr(Evolve, 'get_run_cost')
        assert callable(getattr(Evolve, 'get_run_cost'))

    def test_run_cost_fields_match_ts(self):
        """RunCost fields match TS SDK RunCost interface.

        TS: runId, index, cost, tokens, model, requests, asOf, isComplete, truncated
        PY: run_id, index, cost, tokens, model, requests, as_of, is_complete, truncated
        """
        expected_fields = {
            'run_id', 'index', 'cost', 'tokens', 'model',
            'requests', 'as_of', 'is_complete', 'truncated',
        }
        actual_fields = set(RunCost.__dataclass_fields__.keys())
        assert actual_fields == expected_fields

    def test_session_cost_fields_match_ts(self):
        """SessionCost fields match TS SDK SessionCost interface.

        TS: sessionTag, totalCost, totalTokens, runs, asOf, isComplete, truncated
        PY: session_tag, total_cost, total_tokens, runs, as_of, is_complete, truncated
        """
        expected_fields = {
            'session_tag', 'total_cost', 'total_tokens', 'runs',
            'as_of', 'is_complete', 'truncated',
        }
        actual_fields = set(SessionCost.__dataclass_fields__.keys())
        assert actual_fields == expected_fields

    def test_agent_response_has_run_id(self):
        """AgentResponse has run_id field matching TS AgentResponse.runId."""
        assert 'run_id' in AgentResponse.__dataclass_fields__

    def test_run_cost_exported_from_package(self):
        """RunCost is exported from evolve package."""
        from evolve import RunCost as ExportedRunCost
        assert ExportedRunCost is RunCost

    def test_session_cost_exported_from_package(self):
        """SessionCost is exported from evolve package."""
        from evolve import SessionCost as ExportedSessionCost
        assert ExportedSessionCost is SessionCost

    def test_exports_in_all(self):
        """RunCost and SessionCost are in __all__."""
        import evolve
        assert 'RunCost' in evolve.__all__
        assert 'SessionCost' in evolve.__all__
