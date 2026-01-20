"""Swarm abstractions for parallel AI agent execution."""

from .swarm import Swarm
from .types import (
    FileMap,
    SwarmConfig,
    BestOfConfig,
    VerifyConfig,
    IndexedMeta,
    ReduceMeta,
    JudgeMeta,
    VerifyMeta,
    BaseMeta,
    OperationType,
    Prompt,
    PromptFn,
    ItemInput,
    SchemaType,
    JudgeDecision,
    VerifyDecision,
    # Callback types
    OnCandidateCompleteCallback,
    OnJudgeCompleteCallback,
    OnWorkerCompleteCallback,
    OnVerifierCompleteCallback,
)
from .results import (
    SwarmResult,
    SwarmResultList,
    ReduceResult,
    BestOfResult,
    BestOfInfo,
    VerifyInfo,
    is_swarm_result,
    SWARM_RESULT_BRAND,
)

__all__ = [
    # Main class
    'Swarm',
    # Config types
    'SwarmConfig',
    'BestOfConfig',
    'VerifyConfig',
    # Result types
    'SwarmResult',
    'SwarmResultList',
    'ReduceResult',
    'BestOfResult',
    'BestOfInfo',
    'VerifyInfo',
    # Meta types
    'IndexedMeta',
    'ReduceMeta',
    'JudgeMeta',
    'VerifyMeta',
    'BaseMeta',
    'OperationType',
    # Other types
    'FileMap',
    'Prompt',
    'PromptFn',
    'ItemInput',
    'SchemaType',
    'JudgeDecision',
    'VerifyDecision',
    # Callback types
    'OnCandidateCompleteCallback',
    'OnJudgeCompleteCallback',
    'OnWorkerCompleteCallback',
    'OnVerifierCompleteCallback',
    # Helpers
    'is_swarm_result',
    'SWARM_RESULT_BRAND',
]
