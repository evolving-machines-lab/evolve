"""Evolve Python SDK - Pythonic wrapper around the TypeScript Evolve SDK."""

from .agent import Evolve
from .config import (
    AgentConfig,
    E2BProvider,
    DaytonaProvider,
    ModalProvider,
    SandboxProvider,
    AgentType,
    WorkspaceMode,
    ReasoningEffort,
    ValidationMode,
    SchemaOptions,
    ComposioConfig,
    ComposioSetup,
    ToolsFilter,
    StorageConfig,
    StorageCredentials,
)
from .results import AgentResponse, CheckpointInfo, ExecuteResult, OutputResult, RunCost, SessionCost, SessionStatus
from .storage_client import StorageClient
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


__version__ = '0.0.28'

__all__ = [
    # Main classes
    'Evolve',
    'Swarm',
    'Pipeline',
    'TerminalPipeline',

    # Evolve Configuration
    'AgentConfig',
    'E2BProvider',
    'DaytonaProvider',
    'ModalProvider',
    'SandboxProvider',
    'AgentType',
    'WorkspaceMode',
    'ReasoningEffort',
    'ValidationMode',
    'SchemaOptions',
    'ComposioConfig',
    'ComposioSetup',
    'ToolsFilter',
    'StorageConfig',
    'StorageCredentials',

    # Evolve Results
    'AgentResponse',
    'CheckpointInfo',
    'ExecuteResult',  # Backward compatibility alias for AgentResponse
    'OutputResult',
    'RunCost',
    'SessionCost',
    'SessionStatus',

    # Storage client
    'StorageClient',

    # Standalone functions
    'storage',
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

    # Retry
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
