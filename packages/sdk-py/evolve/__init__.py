"""Evolve Python SDK - Pythonic wrapper around the TypeScript Evolve SDK."""

from .agent import Evolve
from .config import (
    AgentConfig,
    E2BProvider,
    ManagedProvider,
    DaytonaProvider,
    ModalProvider,
    SandboxCreateOptions,
    SandboxNetworkPolicy,
    SandboxProvider,
    AgentType,
    WorkspaceMode,
    BrowserProvider,
    BrowserConfig,
    BrowserCredentialScopeEntry,
    BrowserCredentialsConfig,
    BrowserCredentialsClientConfig,
    BrowserProfilesClientConfig,
    ManagedSecretRef,
    ManagedSecretsClientConfig,
    AgentPluginConfig,
    ReasoningEffort,
    AgentPreset,
    ValidationMode,
    SchemaOptions,
    IntegrationsConfig,
    IntegrationsSetup,
    IntegrationToolsFilter,
    StorageConfig,
    StorageCredentials,
    SessionsConfig,
    HostedClientConfig,
)
from .hosted import (
    EFFORT_SUPPORT_VALUES,
    ActiveDataset,
    Agent,
    AgentArm,
    AgentCapability,
    AgentDatasetStats,
    AgentInfo,
    AgentModelOption,
    AgentPage,
    AgentResult,
    AgentsClient,
    ApiKey,
    AttemptPhase,
    AuthClient,
    AuthStatus,
    CapabilityDocument,
    CompareCell,
    CompareCoverage,
    CompareJobAggregate,
    CompareResponse,
    CompareTaskRow,
    Dataset,
    DatasetImport,
    DatasetImportFailure,
    DatasetManifestAuthor,
    DatasetManifestMetadata,
    DatasetImportPage,
    DatasetPage,
    DatasetRef,
    DatasetSelector,
    DatasetVersion,
    DatasetVersionGate,
    DatasetVersionGateFailedTask,
    DatasetVersionGateUnproven,
    DatasetVersionSource,
    DatasetsClient,
    EvalSandboxProvider,
    EvolveAPIError,
    EvolveDigestMismatchError,
    EvolveIncompleteDownloadError,
    ExceptionInfo,
    GateRunningError,
    GateRunningProgress,
    HostedEvolve,
    HOSTED_ERROR_CODES,
    HostedErrorCode,
    ImportTaskFailure,
    ImportWarning,
    Job,
    JobCounts,
    JobEvent,
    JobFailure,
    JobPage,
    JobRetryConfig,
    JobRetryConfigInput,
    JobSecretRef,
    JobSecretInline,
    JobStats,
    JobStatus,
    JobTaskRollup,
    JobTaskRollupPage,
    JobsClient,
    JudgeResult,
    ModelInfo,
    NoActiveVersionError,
    ManagedProviderCapability,
    PassAtKGroup,
    PassAtKPoint,
    ProviderCapability,
    SkillLock,
    SkillUpload,
    SkillUploadPage,
    SkillsClient,
    SourceJob,
    SpendSource,
    StatusVocabulary,
    StopResponse,
    Task,
    TaskGate,
    TaskPage,
    TaskProviderVerdict,
    TimingInfo,
    TraceEvent,
    TraceEventPage,
    JobGrepGroup,
    JobGrepPage,
    Trial,
    TrialFile,
    TrialFilePage,
    TrialPage,
    TrialRetry,
    TrialStatus,
    TrialTally,
    TrialsClient,
    UpstreamStatus,
    VerifierEnvironmentMode,
    VerifierResult,
    is_hosted_error_code,
    meta,
    pass_at_k,
)
from .results import (
    AgentResponse,
    CheckpointInfo,
    ExecuteResult,
    OutputResult,
    RunCost,
    SessionCost,
    SessionStatus,
    SessionInfo,
    SessionPage,
    SessionEvent,
    BrowserReplay,
)
from .storage_client import StorageClient
from .sessions_client import SessionsClient
from .browser_credentials import BrowserCredentialsClient, BrowserCredentialMetadata, BrowserCredentialsPage
from .browser_profiles import BrowserProfilesClient, BrowserProfileMetadata, BrowserProfilesPage
from .managed_secrets import (
    ManagedSecretsClient,
    ManagedSecretMetadata,
    ManagedSecretWriteResult,
    ManagedSecretDeleteResult,
)
from .utils import read_local_dir, save_local_dir
from .bridge import (
    SandboxNotFoundError,
    BridgeConnectionError,
    BridgeBuildError,
)
from .retry import RetryConfig, OnItemRetryCallback, execute_with_retry
from .swarm import (
    Swarm,
    SwarmConfig,
    BestOfConfig,
    VerifyConfig,
    SwarmResult,
    SwarmResultList,
    ReduceResult,
    BestOfResult,
    BestOfInfo,
    VerifyInfo,
    IndexedMeta,
    ReduceMeta,
    JudgeMeta,
    VerifyMeta,
    VerifyDecision,
    is_swarm_result,
    # Callback types
    OnCandidateCompleteCallback,
    OnJudgeCompleteCallback,
    OnWorkerCompleteCallback,
    OnVerifierCompleteCallback,
)
from .pipeline import (
    Pipeline,
    TerminalPipeline,
    MapConfig,
    FilterConfig,
    ReduceConfig,
    StepResult,
    PipelineResult,
    PipelineEvents,
    StepStartEvent,
    StepCompleteEvent,
    StepErrorEvent,
    ItemRetryEvent,
    WorkerCompleteEvent,
    VerifierCompleteEvent,
    CandidateCompleteEvent,
    JudgeCompleteEvent,
    EmitOption,
)

from typing import List, Optional


def storage(config: Optional[StorageConfig] = None) -> StorageClient:
    """Create a standalone storage client for checkpoint browsing and download.

    Returns a ``StorageClient`` that manages its own bridge subprocess.
    Use as an async context manager to ensure cleanup.

    Args:
        config: Storage configuration (BYOK S3 or None for gateway mode)

    Returns:
        StorageClient with list_checkpoints, get_checkpoint,
        download_checkpoint, download_files methods

    Example:
        >>> from evolve import storage, StorageConfig
        >>>
        >>> # BYOK mode
        >>> async with storage(StorageConfig(url='s3://my-bucket/')) as store:
        ...     checkpoints = await store.list_checkpoints(limit=5)
        ...     files = await store.download_files(checkpoints[0].id)
        >>>
        >>> # Gateway mode (uses EVOLVE_API_KEY)
        >>> async with storage() as store:
        ...     checkpoints = await store.list_checkpoints()
    """
    from .bridge import BridgeManager
    bridge = BridgeManager()
    return StorageClient(bridge, config or StorageConfig(), _owns_bridge=True)


def sessions(config: Optional[SessionsConfig] = None) -> SessionsClient:
    """Create a standalone sessions client for historical traces and past sessions.

    Returns a ``SessionsClient`` that manages its own bridge subprocess.
    Use as an async context manager to ensure cleanup.

    Gateway-only: requires ``EVOLVE_API_KEY`` unless ``SessionsConfig(api_key=...)``
    is provided.

    Args:
        config: Optional API key / dashboard URL overrides

    Returns:
        SessionsClient with list, get, events, download, browser_replay methods

    Example:
        >>> from evolve import sessions
        >>>
        >>> async with sessions() as client:
        ...     page = await client.list(limit=10, state='ended')
        ...     trace = await client.get(page.items[0].id)
        ...     await client.download(trace.id, to='./traces')
        ...     await client.browser_replay(trace.id)
    """
    from .bridge import BridgeManager
    bridge = BridgeManager()
    return SessionsClient(bridge, config or SessionsConfig(), _owns_bridge=True)


def browser_credentials(config: Optional[BrowserCredentialsClientConfig] = None) -> BrowserCredentialsClient:
    """Create a standalone browser credentials client.

    Uses EVOLVE_API_KEY unless BrowserCredentialsClientConfig(api_key=...) is provided.
    Passwords are encrypted locally before they are sent to the dashboard.
    """
    return BrowserCredentialsClient(config or BrowserCredentialsClientConfig())


def browser_profiles(config: Optional[BrowserProfilesClientConfig] = None) -> BrowserProfilesClient:
    """Create a standalone browser profiles client.

    Uses EVOLVE_API_KEY unless BrowserProfilesClientConfig(api_key=...) is provided.
    """
    return BrowserProfilesClient(config or BrowserProfilesClientConfig())


def datasets(config: Optional[HostedClientConfig] = None) -> DatasetsClient:
    """Create a standalone hosted-evals datasets client (shared catalog).

    Uses EVOLVE_API_KEY unless HostedClientConfig(api_key=...) is provided.
    """
    return DatasetsClient(config)


def agents(config: Optional[HostedClientConfig] = None) -> AgentsClient:
    """Create a standalone hosted-evals registered-agents client.

    Register a private agent once, then name it in job agents[].name
    exactly like a built-in. Uses EVOLVE_API_KEY unless
    HostedClientConfig(api_key=...) is provided.
    """
    return AgentsClient(config)


def hosted(config: Optional[HostedClientConfig] = None) -> HostedEvolve:
    """Open the hosted surface with ONE configuration.

    Named ``hosted()`` rather than ``evolve()`` deliberately: ``Evolve`` is
    already the local-sandbox class in this same package, and two exports one
    shift key apart that do completely different things is a trap. ``hosted()``
    says which half of the SDK you are reaching for.

    The four clients underneath are built lazily, so ``await hosted().meta()``
    works with no API key configured::

        from evolve import hosted

        client = hosted()
        doc = await client.meta()            # public, no key needed
        job = await client.jobs.start(...)   # needs EVOLVE_API_KEY
    """
    return HostedEvolve(config)


def jobs(config: Optional[HostedClientConfig] = None) -> JobsClient:
    """Create a standalone hosted-evals jobs client.

    Uses EVOLVE_API_KEY unless HostedClientConfig(api_key=...) is provided.
    watch() consumes the job's server-sent event stream until the job is
    terminal, mirroring the TypeScript SDK.
    """
    return JobsClient(config)


def trials(config: Optional[HostedClientConfig] = None) -> TrialsClient:
    """Create a standalone hosted-evals trials client.

    A trial id is globally addressable — no method takes a job id. Uses
    EVOLVE_API_KEY unless HostedClientConfig(api_key=...) is provided.
    """
    return TrialsClient(config)


def skills(config: Optional[HostedClientConfig] = None) -> SkillsClient:
    """Create a standalone hosted-evals skills client (platform uploads).

    An uploaded skill is an immutable folder referenced as ``upload:<id>`` in
    job ``agents[].skills``, next to skills.sh and git references. Uses
    EVOLVE_API_KEY unless HostedClientConfig(api_key=...) is provided.
    """
    return SkillsClient(config)


def auth(config: Optional[HostedClientConfig] = None) -> AuthClient:
    """Create a standalone hosted-evals auth client (caller identity).

    Wave-gated: until the server's wave lands, status() reports the route's
    not-found as the API error it is. Uses EVOLVE_API_KEY unless
    HostedClientConfig(api_key=...) is provided.
    """
    return AuthClient(config)


def managed_secrets(config: Optional[ManagedSecretsClientConfig] = None) -> ManagedSecretsClient:
    """Create a standalone managed secrets client.

    Uses EVOLVE_API_KEY unless ManagedSecretsClientConfig(api_key=...) is provided.
    Values are never returned.
    """
    return ManagedSecretsClient(config or ManagedSecretsClientConfig())


async def list_checkpoints(
    storage: Optional[StorageConfig] = None,
    limit: Optional[int] = None,
    tag: Optional[str] = None,
) -> List[CheckpointInfo]:
    """List checkpoints without creating a full Evolve instance.

    Uses the lightweight :class:`StorageClient` path instead of a full
    Evolve initialization (no agent/sandbox setup needed).

    Args:
        storage: Storage configuration (BYOK S3 or None for gateway mode)
        limit: Maximum number of checkpoints to return
        tag: Filter by session tag

    Returns:
        List of CheckpointInfo sorted by newest first

    Example:
        >>> from evolve import list_checkpoints, StorageConfig
        >>> checkpoints = await list_checkpoints(
        ...     storage=StorageConfig(url='s3://my-bucket/prefix/'),
        ...     limit=10,
        ... )
    """
    from .bridge import BridgeManager
    bridge = BridgeManager()
    store = StorageClient(bridge, storage or StorageConfig(), _owns_bridge=True)
    try:
        return await store.list_checkpoints(limit=limit, tag=tag)
    finally:
        await store.close()


__version__ = '0.0.52'

__all__ = [
    # Main classes
    'Evolve',
    'Swarm',
    'Pipeline',
    'TerminalPipeline',

    # Evolve Configuration
    'AgentConfig',
    'E2BProvider',
    'ManagedProvider',
    'DaytonaProvider',
    'ModalProvider',
    'SandboxProvider',
    'AgentType',
    'WorkspaceMode',
    'BrowserProvider',
    'BrowserConfig',
    'BrowserCredentialScopeEntry',
    'BrowserCredentialsConfig',
    'BrowserCredentialsClientConfig',
    'BrowserProfilesClientConfig',
    'ManagedSecretRef',
    'ManagedSecretsClientConfig',
    'AgentPluginConfig',
    'ReasoningEffort',
    'AgentPreset',
    'ValidationMode',
    'SchemaOptions',
    'IntegrationsConfig',
    'IntegrationsSetup',
    'IntegrationToolsFilter',
    'StorageConfig',
    'StorageCredentials',
    'SessionsConfig',
    'BrowserCredentialsClient',
    'BrowserCredentialMetadata',
    'BrowserCredentialsPage',
    'BrowserProfilesClient',
    'BrowserProfileMetadata',
    'BrowserProfilesPage',
    'ManagedSecretsClient',
    'ManagedSecretMetadata',
    'ManagedSecretWriteResult',
    'ManagedSecretDeleteResult',
    'SandboxCreateOptions',
    'SandboxNetworkPolicy',

    # Evolve Results
    'AgentResponse',
    'CheckpointInfo',
    'ExecuteResult',  # Backward compatibility alias for AgentResponse
    'OutputResult',
    'RunCost',
    'SessionCost',
    'SessionStatus',
    'SessionInfo',
    'SessionPage',
    'SessionEvent',
    'BrowserReplay',

    # Standalone clients
    'StorageClient',
    'SessionsClient',
    'browser_credentials',
    'browser_profiles',
    'managed_secrets',

    # Hosted evals (datasets + agents + jobs + trials + auth)
    'HostedClientConfig',
    'DatasetsClient',
    'AgentsClient',
    'JobsClient',
    'TrialsClient',
    'AuthClient',
    'EvolveAPIError',
    'EvolveDigestMismatchError',
    'EvolveIncompleteDownloadError',
    'NoActiveVersionError',
    'GateRunningError',
    'GateRunningProgress',
    'Dataset',
    'ActiveDataset',
    'DatasetManifestAuthor',
    'DatasetManifestMetadata',
    'DatasetVersion',
    'DatasetVersionSource',
    'DatasetVersionGate',
    'DatasetVersionGateFailedTask',
    'DatasetVersionGateUnproven',
    'DatasetRef',
    'DatasetSelector',
    'DatasetImport',
    'DatasetImportFailure',
    'ImportTaskFailure',
    'ImportWarning',
    'Task',
    'TaskGate',
    'TaskProviderVerdict',
    'AgentArm',
    'AgentDatasetStats',
    'Job',
    'JobCounts',
    'JobFailure',
    'JobRetryConfig',
    'JobRetryConfigInput',
    'JobSecretRef',
    'JobSecretInline',
    'JobStats',
    'JobStatus',
    'TrialStatus',
    'EvalSandboxProvider',
    'SpendSource',
    'VerifierEnvironmentMode',
    'AttemptPhase',
    'JobTaskRollup',
    'PassAtKGroup',
    'PassAtKPoint',
    'pass_at_k',
    'SourceJob',
    'SkillLock',
    'SkillUpload',
    'SkillUploadPage',
    'SkillsClient',
    'TrialTally',
    'JobEvent',
    'CompareResponse',
    'CompareJobAggregate',
    'CompareCell',
    'CompareCoverage',
    'CompareTaskRow',
    'Trial',
    'TrialRetry',
    'TimingInfo',
    'ModelInfo',
    'AgentInfo',
    'AgentResult',
    'JudgeResult',
    'VerifierResult',
    'ExceptionInfo',
    'StopResponse',
    'TraceEvent',
    'TraceEventPage',
    'JobGrepGroup',
    'JobGrepPage',
    'TrialFile',
    'TrialFilePage',
    'JobPage',
    'TrialPage',
    'JobTaskRollupPage',
    'DatasetPage',
    'AgentPage',
    'TaskPage',
    'Agent',
    'DatasetImportPage',
    'ApiKey',
    'AuthStatus',
    'datasets',
    'agents',
    'jobs',
    'trials',
    'skills',
    'auth',
    'hosted',
    'meta',
    'HostedEvolve',
    'CapabilityDocument',
    'AgentCapability',
    'AgentModelOption',
    'EFFORT_SUPPORT_VALUES',
    'ManagedProviderCapability',
    'ProviderCapability',
    'StatusVocabulary',
    'UpstreamStatus',
    'HOSTED_ERROR_CODES',
    'HostedErrorCode',
    'is_hosted_error_code',

    # Standalone functions
    'storage',
    'sessions',
    'list_checkpoints',

    # Swarm Configuration
    'SwarmConfig',
    'BestOfConfig',
    'VerifyConfig',

    # Swarm Results
    'SwarmResult',
    'SwarmResultList',
    'ReduceResult',
    'BestOfResult',
    'BestOfInfo',
    'VerifyInfo',
    'VerifyDecision',

    # Swarm Metadata
    'IndexedMeta',
    'ReduceMeta',
    'JudgeMeta',
    'VerifyMeta',

    # Swarm Helpers
    'is_swarm_result',

    # Swarm Callback types
    'OnCandidateCompleteCallback',
    'OnJudgeCompleteCallback',
    'OnWorkerCompleteCallback',
    'OnVerifierCompleteCallback',

    # Pipeline Configuration
    'MapConfig',
    'FilterConfig',
    'ReduceConfig',

    # Pipeline Results
    'StepResult',
    'PipelineResult',

    # Pipeline Events
    'PipelineEvents',
    'StepStartEvent',
    'StepCompleteEvent',
    'StepErrorEvent',
    'ItemRetryEvent',
    'WorkerCompleteEvent',
    'VerifierCompleteEvent',
    'CandidateCompleteEvent',
    'JudgeCompleteEvent',
    'EmitOption',

    # Retry — the SWARM client-side retry helper. The hosted job auto-retry
    # policy is a different shape with its own names: JobRetryConfig /
    # JobRetryConfigInput above (the spec calls that pair RetryConfig /
    # RetryConfigInput; the Python export is prefixed so the two never shadow).
    'RetryConfig',
    'OnItemRetryCallback',
    'execute_with_retry',

    # Utilities
    'read_local_dir',
    'save_local_dir',

    # Exceptions
    'SandboxNotFoundError',
    'BridgeConnectionError',
    'BridgeBuildError',
]
