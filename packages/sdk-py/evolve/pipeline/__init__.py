"""Pipeline - Fluent API for chaining Swarm operations."""

from .pipeline import Pipeline, TerminalPipeline
from .types import (
    # Step configs
    MapConfig,
    FilterConfig,
    ReduceConfig,
    # Results
    StepResult,
    PipelineResult,
    # Events
    PipelineEvents,
    PipelineEventMap,
    StepEvent,
    StepStartEvent,
    StepCompleteEvent,
    StepErrorEvent,
    ItemRetryEvent,
    WorkerCompleteEvent,
    VerifierCompleteEvent,
    CandidateCompleteEvent,
    JudgeCompleteEvent,
    # Types
    EmitOption,
    EventName,
    Step,
    StepType,
)

__all__ = [
    # Main classes
    'Pipeline',
    'TerminalPipeline',
    # Step configs
    'MapConfig',
    'FilterConfig',
    'ReduceConfig',
    # Results
    'StepResult',
    'PipelineResult',
    # Events
    'PipelineEvents',
    'PipelineEventMap',
    'StepEvent',
    'StepStartEvent',
    'StepCompleteEvent',
    'StepErrorEvent',
    'ItemRetryEvent',
    'WorkerCompleteEvent',
    'VerifierCompleteEvent',
    'CandidateCompleteEvent',
    'JudgeCompleteEvent',
    # Types
    'EmitOption',
    'EventName',
    'Step',
    'StepType',
]
