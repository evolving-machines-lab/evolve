"""Configuration types for Evolve SDK."""

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Protocol, TypedDict, Union, runtime_checkable


AgentType = Literal['codex', 'claude', 'gemini', 'qwen', 'kimi', 'opencode', 'droid']
WorkspaceMode = Literal['knowledge', 'swe', 'task']
BrowserProvider = Literal['browser-use', 'actionbook', 'agent-browser']
BrowserConfig = Union[BrowserProvider, Dict[str, Any]]
AgentPluginConfig = Dict[str, Any]
ReasoningEffort = Literal['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking', 'no-thinking']
ValidationMode = Literal['strict', 'loose']


class SandboxNetworkPolicy(TypedDict, total=False):
    outbound: Literal['open', 'blocked']
    allowedDestinations: List[str]


class SandboxCreateOptions(TypedDict, total=False):
    image: str
    envs: Dict[str, str]
    metadata: Dict[str, str]
    timeoutMs: int
    workingDirectory: str
    network: SandboxNetworkPolicy
    # Run all commands and file operations as this user; providers must reject
    # it if they cannot enforce it, never silently ignore it.
    user: str
    # Home directory for agent config paths. Default: "/root" when user is
    # "root", "/home/<user>" otherwise, "/home/user" when no user is given.
    homeDir: str


@dataclass
class SchemaOptions:
    """Validation options for schema validation.

    Args:
        mode: Validation mode - 'strict' (exact types) or 'loose' (coerce types, default)
    """
    mode: ValidationMode = 'loose'


@dataclass
class BrowserCredentialScopeEntry:
    """Saved browser login selector for a run.

    Args:
        website: Website/domain, e.g. "github.com"
        account_label: Optional one-word label for a saved credential, such as "qa-admin" or "work"; not the website username or email
    """
    website: str
    account_label: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'website': self.website}
        if self.account_label:
            result['account_label'] = self.account_label
        return result


@dataclass
class BrowserCredentialsConfig:
    """Browser login MCP configuration for managed remote agent-browser runs.

    Args:
        allow: Optional list of website/account_label selectors. None or [] exposes all enabled browser logins.
    """
    allow: Optional[List[Union[BrowserCredentialScopeEntry, Dict[str, Any]]]] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.allow:
            result['allow'] = [
                entry.to_dict() if isinstance(entry, BrowserCredentialScopeEntry) else dict(entry)
                for entry in self.allow
            ]
        return result


@dataclass
class HostedClientConfig:
    """Standalone hosted evals client configuration (datasets/jobs).

    Args:
        api_key: Evolve API key override (default: EVOLVE_API_KEY)
        base_url: API base URL override (default: the Evolve dashboard API)
    """
    api_key: Optional[str] = None
    base_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.api_key:
            result['api_key'] = self.api_key
        if self.base_url:
            result['base_url'] = self.base_url
        return result


@dataclass
class BrowserCredentialsClientConfig:
    """Standalone browser credentials client configuration.

    Args:
        api_key: Evolve API key override
        dashboard_url: Dashboard URL override
    """
    api_key: Optional[str] = None
    dashboard_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.api_key:
            result['api_key'] = self.api_key
        if self.dashboard_url:
            result['dashboard_url'] = self.dashboard_url
        return result


@dataclass
class BrowserProfilesClientConfig:
    """Standalone browser profiles client configuration.

    Args:
        api_key: Evolve API key override
        dashboard_url: Dashboard URL override
    """
    api_key: Optional[str] = None
    dashboard_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        if self.api_key:
            result['api_key'] = self.api_key
        if self.dashboard_url:
            result['dashboard_url'] = self.dashboard_url
        return result


@dataclass
class ManagedSecretRef:
    """Dashboard-stored managed secret to expose as an opaque sandbox env var.

    Args:
        name: Stable Dashboard secret name, e.g. "GITHUB_TOKEN"
        as_name: Optional env var alias in the sandbox. Defaults to name.
    """
    name: str
    as_name: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'name': self.name}
        if self.as_name:
            result['as'] = self.as_name
        return result


@dataclass
class ManagedSecretsClientConfig:
    """Standalone managed secrets client configuration.

    Args:
        api_key: Evolve API key override
        dashboard_url: Dashboard URL override
    """
    api_key: Optional[str] = None
    dashboard_url: Optional[str] = None


@dataclass
class AgentConfig:
    """Agent configuration.

    Three modes of operation:
    - Gateway mode: Use `api_key` (Evolve key) for dashboard observability
    - Direct mode: Use `provider_api_key` (BYOK) to connect directly to providers
    - OAuth mode: Use `oauth_token` for Claude Max subscription (Claude only)

    All fields are optional - TS SDK auto-detects from environment variables.

    Args:
        type: Agent type (codex, claude, gemini, qwen, kimi, opencode, droid) - defaults to 'claude'
        api_key: Evolve API key for gateway mode (defaults to EVOLVE_API_KEY env var)
        provider_api_key: Provider API key for direct mode / BYOK (defaults to provider env var)
        oauth_token: OAuth token for Claude Max subscription (defaults to CLAUDE_CODE_OAUTH_TOKEN env var)
        provider_base_url: Provider base URL for direct mode (auto-detected for Qwen)
        model: Model name (optional - uses agent's default if not specified). Use 'fable' for Claude Fable 5 or 'sonnet[1m]' / 'opus[1m]' for 1M context window (Claude only).
        reasoning_effort: Reasoning effort for models that support it (optional)
        max_context_size: Context/completion ceiling for CLIs that must be told one
            (Kimi Code reads it as max_context_size and sends it as the request's
            max_tokens). Set it to the model's real ceiling when driving a harness
            against a model from another family - e.g. Kimi Code against 'gpt-5.5'
            through an OpenAI-compatible gateway, where an oversized max_tokens is
            rejected with a 400. When set it is used verbatim. When omitted, the
            harness's own models keep their registry value and any other model falls
            back to a conservative 128000. Harnesses that never send a ceiling ignore it.
    """
    type: Optional[AgentType] = None
    api_key: Optional[str] = None
    provider_api_key: Optional[str] = None
    oauth_token: Optional[str] = None
    provider_base_url: Optional[str] = None
    model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    max_context_size: Optional[int] = None


@runtime_checkable
class SandboxProvider(Protocol):
    """Sandbox provider protocol.

    Any sandbox provider must implement this protocol.
    Currently supported: E2BProvider, DaytonaProvider, ModalProvider

    To add a new provider:
    1. Create a class with `type` and `config` properties
    2. Add handling in bridge/src/adapter.ts
    """

    @property
    def type(self) -> str:
        """Provider type identifier (e.g., 'e2b', 'daytona')."""
        ...

    @property
    def config(self) -> dict:
        """Provider configuration dict for the bridge."""
        ...


@dataclass
class ManagedProvider:
    """A sandbox the Evolve platform runs for you.

    Managed mode means you hold an Evolve API key and no provider credential at
    all: the Dashboard authenticates the key, records ownership, and makes the
    provider call with platform credentials.

    Which provider backs the sandbox is an argument here — never an
    environment variable — so a program says what it runs on.

    Args:
        provider: 'e2b' (default), 'daytona', or 'modal'.
        api_key: Evolve API key (defaults to the EVOLVE_API_KEY env var)
        timeout_ms: Lifetime cap (ms) applied to every sandbox this provider
            creates; per-create options still win.
        resources: Compute sizing applied to every create, as a dict with
            'cpu' (cores), 'memory' and 'disk' (GiB) keys. Providers and the
            managed doors reject entries they cannot enforce — never
            silently ignored.

    Example:
        >>> evolve = Evolve(sandbox=ManagedProvider(provider='daytona', timeout_ms=7_200_000))
    """
    provider: Literal['e2b', 'daytona', 'modal'] = 'e2b'
    api_key: Optional[str] = None
    timeout_ms: Optional[int] = None
    resources: Optional[dict] = None

    @property
    def type(self) -> Literal['managed']:
        """Provider type."""
        return 'managed'

    @property
    def config(self) -> dict:
        """Provider configuration dict."""
        result: dict = {'provider': self.provider}
        if self.api_key:
            result['apiKey'] = self.api_key
        if self.timeout_ms is not None:
            result['timeoutMs'] = self.timeout_ms
        if self.resources is not None:
            result['resources'] = self.resources
        return result


@dataclass
class E2BProvider:
    """E2B sandbox provider configuration.

    Args:
        api_key: E2B API key (defaults to E2B_API_KEY env var)
        timeout_ms: Sandbox timeout in milliseconds (default: 3600000 = 1 hour)
        template_id: E2B template ID (default: 'evolve-all'). Create custom templates at https://e2b.dev/docs/sandbox-template
    """
    api_key: Optional[str] = None
    timeout_ms: int = 3600000
    template_id: Optional[str] = None

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
        if self.template_id:
            result['templateId'] = self.template_id
        return result


@dataclass
class DaytonaProvider:
    """Daytona sandbox provider configuration.

    Args:
        api_key: Daytona API key (defaults to DAYTONA_API_KEY env var)
        api_url: API URL (defaults to https://app.daytona.io/api)
        target: Target region (defaults to 'us')
        timeout_ms: Sandbox timeout in milliseconds (default: 3600000 = 1 hour)
        snapshot_name: Daytona snapshot name (default: the current release
            snapshot, 'evolve-all-c-<12hex>' with the tag derived from the
            image build inputs; explicit names pass through untouched).
            Custom snapshots via ``cd assets && ./build.sh daytona``
    """
    api_key: Optional[str] = None
    api_url: Optional[str] = None
    target: Optional[str] = None
    timeout_ms: int = 3600000
    snapshot_name: Optional[str] = None

    @property
    def type(self) -> Literal['daytona']:
        """Provider type."""
        return 'daytona'

    @property
    def config(self) -> dict:
        """Provider configuration dict."""
        result = {}
        if self.api_key:
            result['apiKey'] = self.api_key
        if self.api_url:
            result['apiUrl'] = self.api_url
        if self.target:
            result['target'] = self.target
        if self.timeout_ms:
            result['defaultTimeoutMs'] = self.timeout_ms
        if self.snapshot_name:
            result['snapshotName'] = self.snapshot_name
        return result


@dataclass
class ModalProvider:
    """Modal sandbox provider configuration.

    Args:
        app_name: Modal app namespace (defaults to 'evolve-sandbox')
        timeout_ms: Sandbox timeout in milliseconds (default: 3600000 = 1 hour)
        token_id: Modal token ID (defaults to MODAL_TOKEN_ID env var)
        token_secret: Modal token secret (defaults to MODAL_TOKEN_SECRET env var)
        endpoint: Modal API endpoint (defaults to https://api.modal.com:443)
        image_name: Docker image name (default: 'evolve-all'). Resolved through IMAGE_MAP or used as-is.
    """
    app_name: Optional[str] = None
    timeout_ms: int = 3600000
    token_id: Optional[str] = None
    token_secret: Optional[str] = None
    endpoint: Optional[str] = None
    image_name: Optional[str] = None

    @property
    def type(self) -> Literal['modal']:
        """Provider type."""
        return 'modal'

    @property
    def config(self) -> dict:
        """Provider configuration dict."""
        result = {}
        if self.app_name:
            result['appName'] = self.app_name
        if self.timeout_ms:
            result['defaultTimeoutMs'] = self.timeout_ms
        if self.token_id:
            result['tokenId'] = self.token_id
        if self.token_secret:
            result['tokenSecret'] = self.token_secret
        if self.endpoint:
            result['endpoint'] = self.endpoint
        if self.image_name:
            result['imageName'] = self.image_name
        return result


# =============================================================================
# STORAGE / CHECKPOINTING
# =============================================================================


@dataclass
class StorageCredentials:
    """S3 credentials for BYOK storage.

    Args:
        access_key_id: AWS access key ID
        secret_access_key: AWS secret access key
    """
    access_key_id: str
    secret_access_key: str


@dataclass
class StorageConfig:
    """Storage configuration for checkpoint persistence.

    Two modes of operation:
    - BYOK mode: Provide `url` (S3 bucket URL) with optional credentials
    - Gateway mode: Leave empty — Evolve-managed storage via EVOLVE_API_KEY

    Args:
        url: S3 bucket URL (e.g., 's3://my-bucket/prefix/')
        bucket: S3 bucket name (alternative to url)
        prefix: Key prefix within bucket
        region: AWS region (default: auto-detect)
        endpoint: Custom S3 endpoint (e.g., Cloudflare R2, MinIO)
        credentials: Explicit S3 credentials (defaults to env AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)
    """
    url: Optional[str] = None
    bucket: Optional[str] = None
    prefix: Optional[str] = None
    region: Optional[str] = None
    endpoint: Optional[str] = None
    credentials: Optional[StorageCredentials] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON-RPC transport."""
        result: Dict[str, Any] = {}
        if self.url:
            result['url'] = self.url
        if self.bucket:
            result['bucket'] = self.bucket
        if self.prefix:
            result['prefix'] = self.prefix
        if self.region:
            result['region'] = self.region
        if self.endpoint:
            result['endpoint'] = self.endpoint
        if self.credentials:
            result['credentials'] = {
                'accessKeyId': self.credentials.access_key_id,
                'secretAccessKey': self.credentials.secret_access_key,
            }
        return result


@dataclass
class SessionsConfig:
    """Configuration for the standalone sessions() client.

    Gateway-only historical trace access. If omitted, the TypeScript sessions()
    client resolves credentials from ``EVOLVE_API_KEY`` and dashboard defaults.

    Args:
        api_key: Explicit Evolve API key override
        dashboard_url: Dashboard URL override (for staging/self-hosted setups)
    """
    api_key: Optional[str] = None
    dashboard_url: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON-RPC transport."""
        result: Dict[str, Any] = {}
        if self.api_key:
            result['apiKey'] = self.api_key
        if self.dashboard_url:
            result['dashboardUrl'] = self.dashboard_url
        return result


# =============================================================================
# MANAGED INTEGRATIONS
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


# Tool filter configuration per app - matches TS SDK IntegrationToolsFilter
IntegrationToolsFilter = Union[List[str], EnableFilter, DisableFilter, TagsFilter]


@dataclass(kw_only=True)
class IntegrationsConfig:
    """Managed integrations configuration.

    Args:
        apps: Apps to expose to the agent (e.g., ["github", "gmail"])
        tools: Per-app tool filtering
        accounts: Pin connected accounts by account ID or account label
        keys: API keys for apps that use API-key auth
        auth_configs: Custom auth config IDs per app
    """
    apps: List[str]
    tools: Optional[Dict[str, IntegrationToolsFilter]] = None
    accounts: Optional[Dict[str, List[str]]] = None
    keys: Optional[Dict[str, str]] = None
    auth_configs: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON-RPC transport."""
        result: Dict[str, Any] = {'apps': self.apps}
        if self.tools:
            result['tools'] = self.tools
        if self.accounts:
            result['accounts'] = self.accounts
        if self.keys:
            result['keys'] = self.keys
        if self.auth_configs:
            result['auth_configs'] = self.auth_configs
        return result


@dataclass(kw_only=True)
class IntegrationsSetup:
    """Managed integrations setup.

    Args:
        user_id: Integration user ID. Use "root" for dashboard-owned/private accounts,
            or your app's stable end-user ID for per-user accounts.
        apps: Apps to expose to the agent
        tools: Per-app tool filtering
        accounts: Pin connected accounts by account ID or account label
        keys: API keys for apps that use API-key auth
        auth_configs: Custom auth config IDs per app
    """
    user_id: str
    apps: List[str]
    tools: Optional[Dict[str, IntegrationToolsFilter]] = None
    accounts: Optional[Dict[str, List[str]]] = None
    keys: Optional[Dict[str, str]] = None
    auth_configs: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dict for JSON-RPC transport."""
        result: Dict[str, Any] = {'user_id': self.user_id, 'apps': self.apps}
        if self.tools:
            result['tools'] = self.tools
        if self.accounts:
            result['accounts'] = self.accounts
        if self.keys:
            result['keys'] = self.keys
        if self.auth_configs:
            result['auth_configs'] = self.auth_configs
        return result
