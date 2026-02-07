"""
Unit tests for BYOK (Bring Your Own Key) auth configuration.

Tests AgentConfig dataclass fields for BYOK support:
- oauth_token: OAuth direct mode (Claude Max subscription, Claude only)
- provider_api_key: Direct mode (BYOK)
- provider_base_url: Custom provider endpoint
- api_key: Gateway mode (Evolve)

Tests E2BProvider config dict generation.
Tests bridge initialization params mapping.

Note: Actual API key resolution and validation happens in the TS SDK.
Python just passes config; TS resolves from env vars and validates.
"""

import os
import pytest
from unittest.mock import patch, MagicMock

from evolve import Evolve
from evolve.config import AgentConfig, E2BProvider
from evolve.bridge import BridgeManager


class TestAgentConfigDataclass:
    """Test AgentConfig dataclass BYOK fields."""

    def test_default_values(self):
        """All fields should default to None."""
        config = AgentConfig()

        assert config.type is None
        assert config.api_key is None
        assert config.provider_api_key is None
        assert config.oauth_token is None
        assert config.provider_base_url is None
        assert config.model is None
        assert config.reasoning_effort is None
        assert config.betas is None

    def test_gateway_mode_config(self):
        """Test config for gateway mode (Evolve key)."""
        config = AgentConfig(
            type='claude',
            api_key='evolve-gateway-key',
            model='opus'
        )

        assert config.type == 'claude'
        assert config.api_key == 'evolve-gateway-key'
        assert config.provider_api_key is None
        assert config.model == 'opus'

    def test_direct_mode_config(self):
        """Test config for direct mode (BYOK)."""
        config = AgentConfig(
            type='claude',
            provider_api_key='sk-ant-direct-key',
            provider_base_url='https://custom.anthropic.com'
        )

        assert config.provider_api_key == 'sk-ant-direct-key'
        assert config.provider_base_url == 'https://custom.anthropic.com'
        assert config.api_key is None

    def test_all_agent_types(self):
        """Test config works for all agent types."""
        agent_types = ['claude', 'codex', 'gemini', 'qwen']

        for agent_type in agent_types:
            config = AgentConfig(
                type=agent_type,
                provider_api_key=f'{agent_type}-direct-key'
            )
            assert config.type == agent_type
            assert config.provider_api_key == f'{agent_type}-direct-key'

    def test_codex_reasoning_effort(self):
        """Test reasoningEffort for Codex models."""
        config = AgentConfig(
            type='codex',
            provider_api_key='openai-key',
            reasoning_effort='high'
        )

        assert config.reasoning_effort == 'high'

    def test_claude_betas(self):
        """Test betas for Claude models."""
        config = AgentConfig(
            type='claude',
            provider_api_key='sk-ant-key',
            betas=['context-1m-2025-08-07']
        )

        assert config.betas == ['context-1m-2025-08-07']

    def test_qwen_direct_mode(self):
        """Test Qwen direct mode config - no baseUrl needed (auto from registry)."""
        config = AgentConfig(
            type='qwen',
            provider_api_key='qwen-api-key',
            # Note: provider_base_url NOT needed for Qwen
            # TS SDK uses registry.defaultBaseUrl automatically
        )

        assert config.type == 'qwen'
        assert config.provider_api_key == 'qwen-api-key'
        assert config.provider_base_url is None  # Auto-resolved by TS SDK


class TestOAuthMode:
    """Test OAuth mode config (Claude Max subscription).

    Note: oauth_token is only valid for Claude agent type.
    The TS SDK validates this and throws an error for non-Claude agents.
    """

    def test_oauth_mode_config(self):
        """Test config for OAuth mode (Claude Max subscription)."""
        config = AgentConfig(
            type='claude',
            oauth_token='oauth-claude-max-token',
            model='sonnet'
        )

        assert config.type == 'claude'
        assert config.oauth_token == 'oauth-claude-max-token'
        assert config.api_key is None
        assert config.provider_api_key is None
        assert config.model == 'sonnet'

    def test_oauth_with_betas(self):
        """Test OAuth mode with betas for Claude."""
        config = AgentConfig(
            type='claude',
            oauth_token='oauth-token',
            betas=['context-1m-2025-08-07']
        )

        assert config.oauth_token == 'oauth-token'
        assert config.betas == ['context-1m-2025-08-07']

    def test_oauth_token_field_exists(self):
        """Test oauth_token field is present in AgentConfig."""
        config = AgentConfig(oauth_token='test-token')
        assert config.oauth_token == 'test-token'

    def test_oauth_takes_priority_documented(self):
        """Document that oauth_token takes priority over other keys.

        TS SDK resolution order:
          Explicit config (always respected):
            1. oauthToken → OAuth direct mode (Claude only)
            2. providerApiKey → direct mode
            3. apiKey → gateway mode
          Environment variables (gateway first for revenue):
            4. EVOLVE_API_KEY env → gateway mode
            5. Provider env var → direct mode
            6. CLAUDE_CODE_OAUTH_TOKEN env → OAuth direct mode

        When multiple are set, TS SDK uses the highest priority one.
        """
        config = AgentConfig(
            type='claude',
            oauth_token='oauth-token',
            provider_api_key='provider-key',
            api_key='gateway-key',
        )

        # Python just passes all values; TS SDK resolves priority
        assert config.oauth_token == 'oauth-token'
        assert config.provider_api_key == 'provider-key'
        assert config.api_key == 'gateway-key'

    def test_oauth_only_for_claude_documented(self):
        """Document that oauth_token is only supported for Claude.

        TS SDK throws error if oauth_token used with non-Claude agent:
        "oauthToken is only supported for claude agent (Claude Max subscription), not {type}.
        Use providerApiKey for {type} instead."

        Python doesn't validate this - it's done by TS SDK.
        """
        # This config would fail in TS SDK - oauth_token with codex
        config = AgentConfig(
            type='codex',
            oauth_token='oauth-token',  # Invalid for codex!
        )

        # Python allows it (dataclass doesn't validate)
        assert config.type == 'codex'
        assert config.oauth_token == 'oauth-token'
        # TS SDK will throw error when this config is used


class TestE2BProvider:
    """Test E2BProvider dataclass and config dict generation."""

    def test_default_values(self):
        """Test default E2BProvider values."""
        provider = E2BProvider()

        assert provider.api_key is None
        assert provider.timeout_ms == 3600000  # 1 hour default
        assert provider.type == 'e2b'

    def test_direct_e2b_config(self):
        """Test E2BProvider with direct API key."""
        provider = E2BProvider(api_key='e2b-direct-key')

        config = provider.config
        assert config['apiKey'] == 'e2b-direct-key'
        assert config['defaultTimeoutMs'] == 3600000

    def test_custom_timeout(self):
        """Test E2BProvider with custom timeout."""
        provider = E2BProvider(
            api_key='e2b-key',
            timeout_ms=7200000  # 2 hours
        )

        config = provider.config
        assert config['defaultTimeoutMs'] == 7200000

    def test_config_without_api_key(self):
        """Test config dict when api_key is None (uses env var)."""
        provider = E2BProvider()

        config = provider.config
        assert 'apiKey' not in config
        assert config['defaultTimeoutMs'] == 3600000

    def test_type_property(self):
        """Test type property returns 'e2b'."""
        provider = E2BProvider()
        assert provider.type == 'e2b'


class TestAgentBridgeConfig:
    """Test agent config is properly passed to bridge."""

    def test_agent_config_to_dict_gateway_mode(self):
        """Test gateway mode config converts to proper dict for bridge."""
        config = AgentConfig(
            type='claude',
            api_key='evolve-key',
            model='sonnet'
        )

        # Simulate what agent.py does when building config dict
        config_dict = {
            'type': config.type,
            'model': config.model,
        }
        if config.api_key:
            config_dict['apiKey'] = config.api_key
        if config.provider_api_key:
            config_dict['providerApiKey'] = config.provider_api_key
        if config.oauth_token:
            config_dict['oauthToken'] = config.oauth_token
        if config.provider_base_url:
            config_dict['providerBaseUrl'] = config.provider_base_url

        assert config_dict['type'] == 'claude'
        assert config_dict['apiKey'] == 'evolve-key'
        assert 'providerApiKey' not in config_dict
        assert 'oauthToken' not in config_dict
        assert config_dict['model'] == 'sonnet'

    def test_agent_config_to_dict_direct_mode(self):
        """Test direct mode config converts to proper dict for bridge."""
        config = AgentConfig(
            type='claude',
            provider_api_key='sk-ant-direct-key',
            provider_base_url='https://custom.anthropic.com',
            model='opus'
        )

        config_dict = {
            'type': config.type,
            'model': config.model,
        }
        if config.api_key:
            config_dict['apiKey'] = config.api_key
        if config.provider_api_key:
            config_dict['providerApiKey'] = config.provider_api_key
        if config.oauth_token:
            config_dict['oauthToken'] = config.oauth_token
        if config.provider_base_url:
            config_dict['providerBaseUrl'] = config.provider_base_url

        assert config_dict['providerApiKey'] == 'sk-ant-direct-key'
        assert config_dict['providerBaseUrl'] == 'https://custom.anthropic.com'
        assert 'apiKey' not in config_dict
        assert 'oauthToken' not in config_dict

    def test_agent_config_to_dict_oauth_mode(self):
        """Test OAuth mode config converts to proper dict for bridge."""
        config = AgentConfig(
            type='claude',
            oauth_token='oauth-claude-max-token',
            model='sonnet',
            betas=['context-1m-2025-08-07']
        )

        config_dict = {
            'type': config.type,
            'model': config.model,
        }
        if config.api_key:
            config_dict['apiKey'] = config.api_key
        if config.provider_api_key:
            config_dict['providerApiKey'] = config.provider_api_key
        if config.oauth_token:
            config_dict['oauthToken'] = config.oauth_token
        if config.provider_base_url:
            config_dict['providerBaseUrl'] = config.provider_base_url
        if config.betas:
            config_dict['betas'] = config.betas

        assert config_dict['oauthToken'] == 'oauth-claude-max-token'
        assert config_dict['betas'] == ['context-1m-2025-08-07']
        assert 'apiKey' not in config_dict
        assert 'providerApiKey' not in config_dict

    def test_agent_config_with_reasoning_effort(self):
        """Test Codex config with reasoning effort."""
        config = AgentConfig(
            type='codex',
            provider_api_key='openai-key',
            reasoning_effort='xhigh'
        )

        config_dict = {
            'type': config.type,
        }
        if config.provider_api_key:
            config_dict['providerApiKey'] = config.provider_api_key
        if config.reasoning_effort:
            config_dict['reasoningEffort'] = config.reasoning_effort

        assert config_dict['providerApiKey'] == 'openai-key'
        assert config_dict['reasoningEffort'] == 'xhigh'

    def test_agent_config_with_betas(self):
        """Test Claude config with betas."""
        config = AgentConfig(
            type='claude',
            provider_api_key='sk-ant-key',
            betas=['context-1m-2025-08-07']
        )

        config_dict = {
            'type': config.type,
        }
        if config.provider_api_key:
            config_dict['providerApiKey'] = config.provider_api_key
        if config.betas:
            config_dict['betas'] = config.betas

        assert config_dict['betas'] == ['context-1m-2025-08-07']


class TestSwarmConfigInheritance:
    """Test BYOK config inheritance in Swarm._build_agent_config()."""

    def test_build_agent_config_inherits_byok_fields(self):
        """Test that _build_agent_config inherits BYOK fields from swarm config."""
        # Simulate swarm config
        swarm_config = AgentConfig(
            type='claude',
            provider_api_key='swarm-level-provider-key',
            provider_base_url='https://swarm-level-url.com',
            model='opus'
        )

        # Simulate task config (no BYOK fields)
        task_config = AgentConfig(
            model='sonnet'  # Override model only
        )

        # Simulate _build_agent_config merge logic
        merged = AgentConfig(
            type=task_config.type or swarm_config.type,
            api_key=task_config.api_key or swarm_config.api_key,
            provider_api_key=task_config.provider_api_key or swarm_config.provider_api_key,
            oauth_token=task_config.oauth_token or swarm_config.oauth_token,
            provider_base_url=task_config.provider_base_url or swarm_config.provider_base_url,
            model=task_config.model or swarm_config.model,
            reasoning_effort=task_config.reasoning_effort or swarm_config.reasoning_effort,
            betas=task_config.betas or swarm_config.betas,
        )

        # BYOK fields should be inherited from swarm config
        assert merged.provider_api_key == 'swarm-level-provider-key'
        assert merged.provider_base_url == 'https://swarm-level-url.com'
        # Model should be overridden by task config
        assert merged.model == 'sonnet'

    def test_task_config_overrides_swarm_byok(self):
        """Test that task-level BYOK fields override swarm-level."""
        swarm_config = AgentConfig(
            type='claude',
            provider_api_key='swarm-level-key',
        )

        task_config = AgentConfig(
            provider_api_key='task-level-key',  # Override
        )

        # Simulate merge - task takes priority
        merged_key = task_config.provider_api_key or swarm_config.provider_api_key

        assert merged_key == 'task-level-key'

    def test_oauth_token_inheritance(self):
        """Test that oauth_token is inherited from swarm config."""
        swarm_config = AgentConfig(
            type='claude',
            oauth_token='swarm-level-oauth-token',
        )

        task_config = AgentConfig(
            model='sonnet'  # Override model only
        )

        # Simulate merge
        merged_oauth = task_config.oauth_token or swarm_config.oauth_token

        assert merged_oauth == 'swarm-level-oauth-token'

    def test_task_oauth_overrides_swarm_oauth(self):
        """Test that task-level oauth_token overrides swarm-level."""
        swarm_config = AgentConfig(
            type='claude',
            oauth_token='swarm-level-oauth',
        )

        task_config = AgentConfig(
            oauth_token='task-level-oauth',  # Override
        )

        # Simulate merge - task takes priority
        merged_oauth = task_config.oauth_token or swarm_config.oauth_token

        assert merged_oauth == 'task-level-oauth'


class TestEnvironmentVariableFallback:
    """Test that config with None values allows env var fallback in TS bridge."""

    def test_empty_config_allows_env_fallback(self):
        """Empty config should allow TS bridge to use env vars."""
        config = AgentConfig()

        # All values None means TS bridge will check env vars
        assert config.api_key is None
        assert config.provider_api_key is None
        # TS resolveAgentConfig will then check:
        # 1. providerApiKey (None - skip)
        # 2. apiKey (None - skip)
        # 3. EVOLVE_API_KEY env (gateway mode, highest priority)
        # 4. ANTHROPIC_API_KEY env (direct mode, fallback)

    def test_type_only_config(self):
        """Config with only type specified allows env var fallback."""
        config = AgentConfig(type='codex')

        assert config.type == 'codex'
        assert config.api_key is None
        assert config.provider_api_key is None
        # TS bridge will check OPENAI_API_KEY or EVOLVE_API_KEY


class TestE2BSandboxEnvResolution:
    """Test E2B sandbox env var resolution (documented behavior, resolved by TS SDK)."""

    def test_e2b_provider_direct_mode(self):
        """E2BProvider with api_key for direct E2B access."""
        provider = E2BProvider(api_key='e2b-direct-key')

        assert provider.type == 'e2b'
        assert provider.config['apiKey'] == 'e2b-direct-key'

    def test_e2b_provider_gateway_mode(self):
        """E2BProvider without api_key uses env var fallback in TS SDK.

        Resolution order in TS resolveDefaultSandbox() (gateway first for revenue):
        1. EVOLVE_API_KEY env → gateway mode (sets E2B_API_URL)
        2. E2B_API_KEY env → direct to E2B
        """
        provider = E2BProvider()  # No api_key - TS SDK resolves from env

        assert provider.type == 'e2b'
        assert 'apiKey' not in provider.config  # Will be resolved by TS SDK

    def test_e2b_provider_env_priority_documented(self):
        """Document the env var priority for E2B sandbox.

        TS SDK resolveDefaultSandbox() priority (gateway first for revenue):
        1. EVOLVE_API_KEY set → Through gateway (recommended)
        2. E2B_API_KEY set → Direct to E2B (fallback)
        """
        # When both are set, EVOLVE_API_KEY takes priority (gateway mode)
        # This is resolved by TS SDK, not Python
        # Python just passes the config, TS does the resolution
        provider = E2BProvider()
        assert provider.type == 'e2b'


class MockBridgeManager:
    """Minimal async bridge mock for Evolve runtime surface tests."""

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
        if method == 'status':
            return {
                'sandbox_id': 'sb-test',
                'sandbox': 'ready',
                'agent': 'idle',
                'active_process_id': None,
                'has_run': True,
                'timestamp': '2026-02-07T00:00:00.000Z',
            }
        if method == 'interrupt':
            return True
        return {'status': 'ok'}


class TestSessionRuntimeParity:
    """Python wrapper parity for TS session runtime controls."""

    @pytest.mark.asyncio
    async def test_initialize_forwards_lifecycle_stream(self):
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve()
            await kit._ensure_initialized()

        initialize_calls = [c for c in mock_bridge.calls if c[0] == 'initialize']
        assert len(initialize_calls) == 1
        params = initialize_calls[0][1]
        assert params['forward_stdout'] is True
        assert params['forward_stderr'] is True
        assert params['forward_content'] is True
        assert params['forward_lifecycle'] is True

    @pytest.mark.asyncio
    async def test_status_returns_typed_snapshot(self):
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve()
            status = await kit.status()

        assert status.sandbox_id == 'sb-test'
        assert status.sandbox == 'ready'
        assert status.agent == 'idle'
        assert status.active_process_id is None
        assert status.has_run is True
        assert status.timestamp == '2026-02-07T00:00:00.000Z'

    @pytest.mark.asyncio
    async def test_interrupt_returns_bool(self):
        mock_bridge = MockBridgeManager()
        with patch('evolve.agent.BridgeManager', return_value=mock_bridge):
            kit = Evolve()
            interrupted = await kit.interrupt()

        assert interrupted is True
        interrupt_calls = [c for c in mock_bridge.calls if c[0] == 'interrupt']
        assert len(interrupt_calls) == 1

    def test_bridge_manager_handles_lifecycle_event_callbacks(self):
        bridge = BridgeManager()
        captured = []
        bridge.on('lifecycle', lambda event: captured.append(event))
        bridge._handle_event({'type': 'lifecycle', 'reason': 'run_start', 'sandbox': 'running'})
        assert len(captured) == 1
        assert captured[0]['reason'] == 'run_start'

    def test_bridge_manager_rejects_unknown_event_type(self):
        bridge = BridgeManager()
        with pytest.raises(ValueError, match='Unsupported event type'):
            bridge.on('invalid-event', lambda _event: None)
