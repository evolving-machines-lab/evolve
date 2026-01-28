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
)
from .results import AgentResponse, ExecuteResult, OutputResult
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

__version__ = '0.0.9'

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

    # Evolve Results
    'AgentResponse',
    'ExecuteResult',  # Backward compatibility alias for AgentResponse
    'OutputResult',

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
