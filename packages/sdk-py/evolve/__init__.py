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
from .results import AgentResponse, CheckpointInfo, ExecuteResult, OutputResult, SessionStatus
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


async def list_checkpoints(
    storage: Optional[StorageConfig] = None,
    limit: Optional[int] = None,
    tag: Optional[str] = None,
) -> List[CheckpointInfo]:
    """List checkpoints without creating a full Evolve instance.

    Standalone convenience function for checkpoint browsing.

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
    kit = Evolve(storage=storage if storage is not None else StorageConfig())
    try:
        return await kit.list_checkpoints(limit=limit, tag=tag)
    finally:
        await kit.bridge.stop()


__version__ = '0.0.20'

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
    'SessionStatus',

    # Standalone functions
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
