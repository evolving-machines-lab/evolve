"""Configuration types for Evolve SDK."""

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Protocol, TypedDict, Union, runtime_checkable


AgentType = Literal['codex', 'claude', 'gemini', 'qwen']
WorkspaceMode = Literal['knowledge', 'swe']
ReasoningEffort = Literal['low', 'medium', 'high', 'xhigh']
ValidationMode = Literal['strict', 'loose']


@dataclass
class SchemaOptions:
    """Validation options for schema validation.

    Args:
        mode: Validation mode - 'strict' (exact types) or 'loose' (coerce types, default)
    """
    mode: ValidationMode = 'loose'


@dataclass
class AgentConfig:
    """Agent configuration.

    Three modes of operation:
    - Gateway mode: Use `api_key` (Evolve key) for dashboard observability
    - Direct mode: Use `provider_api_key` (BYOK) to connect directly to providers
    - OAuth mode: Use `oauth_token` for Claude Max subscription (Claude only)

    All fields are optional - TS SDK auto-detects from environment variables.

    Args:
        type: Agent type (codex, claude, gemini, qwen) - defaults to 'claude'
        api_key: Evolve API key for gateway mode (defaults to EVOLVE_API_KEY env var)
        provider_api_key: Provider API key for direct mode / BYOK (defaults to provider env var)
        oauth_token: OAuth token for Claude Max subscription (defaults to CLAUDE_CODE_OAUTH_TOKEN env var)
        provider_base_url: Provider base URL for direct mode (auto-detected for Qwen)
        model: Model name (optional - uses agent's default if not specified)
        reasoning_effort: Reasoning effort for Codex models (optional)
        betas: Beta headers for Claude (Sonnet 4.5 only; e.g. ["context-1m-2025-08-07"] for 1M context)
    """
    type: Optional[AgentType] = None
    api_key: Optional[str] = None
    provider_api_key: Optional[str] = None
    oauth_token: Optional[str] = None
    provider_base_url: Optional[str] = None
    model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    betas: Optional[List[str]] = None


@runtime_checkable
class SandboxProvider(Protocol):
    """Sandbox provider protocol.

    Any sandbox provider must implement this protocol.
    Currently supported: E2BProvider

    To add a new provider:
    1. Create a class with `type` and `config` properties
    2. Add handling in bridge/src/adapter.ts
    """

    @property
    def type(self) -> str:
        """Provider type identifier (e.g., 'e2b')."""
        ...

    @property
    def config(self) -> dict:
        """Provider configuration dict for the bridge."""
        ...


@dataclass
class E2BProvider:
    """E2B sandbox provider configuration.

    Args:
        api_key: E2B API key (defaults to E2B_API_KEY env var)
        timeout_ms: Sandbox timeout in milliseconds (default: 3600000 = 1 hour)
    """
    api_key: Optional[str] = None
    timeout_ms: int = 3600000

    @property
    def type(self) -> Literal['e2b']:
        """Provider type."""
        return 'e2b'

    @property
    def config(self) -> dict:
        """Provider configuration dict."""
        result = {}
        if self.api_key:
            result['apiKey'] = self.api_key
        if self.timeout_ms:
            result['defaultTimeoutMs'] = self.timeout_ms
        return result


# =============================================================================
# COMPOSIO TOOL ROUTER
# =============================================================================


class EnableFilter(TypedDict):
    """Enable only specific tools."""
    enable: List[str]


class DisableFilter(TypedDict):
    """Disable specific tools."""
    disable: List[str]


class TagsFilter(TypedDict):
    """Filter by behavior tags."""
    tags: List[str]


# Tool filter configuration per toolkit - matches TS SDK ToolsFilter
ToolsFilter = Union[List[str], EnableFilter, DisableFilter, TagsFilter]


@dataclass
class ComposioConfig:
    """Composio Tool Router configuration.

    Args:
        toolkits: Restrict to specific toolkits (e.g., ["github", "gmail"])
        tools: Per-toolkit tool filtering
        keys: API keys for direct auth (bypasses OAuth)
        auth_configs: Custom OAuth auth config IDs for white-labeling
    """
    toolkits: Optional[List[str]] = None
    tools: Optional[Dict[str, ToolsFilter]] = None
    keys: Optional[Dict[str, str]] = None
    auth_configs: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON-RPC transport."""
        result: Dict[str, Any] = {}
        if self.toolkits:
            result['toolkits'] = self.toolkits
        if self.tools:
            result['tools'] = self.tools
        if self.keys:
            result['keys'] = self.keys
        if self.auth_configs:
            result['authConfigs'] = self.auth_configs
        return result


@dataclass
class ComposioSetup:
    """Composio setup combining user ID and configuration.

    Args:
        user_id: User's unique identifier for Composio session
        config: Optional Composio configuration
    """
    user_id: str
    config: Optional[ComposioConfig] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON-RPC transport."""
        result: Dict[str, Any] = {'user_id': self.user_id}
        if self.config:
            result['config'] = self.config.to_dict()
        return result
