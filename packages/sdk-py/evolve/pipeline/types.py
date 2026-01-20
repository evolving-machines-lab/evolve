"""Pipeline Types - Fluent API for chaining Swarm operations."""

from dataclasses import dataclass
from typing import Any, Callable, Dict, Generic, List, Literal, Optional, TypeVar, Union

from ..swarm.types import (
    BestOfConfig,
    VerifyConfig,
    SchemaType,
    Prompt,
)
from ..swarm.results import SwarmResult, ReduceResult
from ..config import ComposioSetup
from ..retry import RetryConfig


T = TypeVar('T')


# =============================================================================
# EMIT OPTION (filter only)
# =============================================================================

EmitOption = Literal["success", "filtered", "all"]
"""What filter emits to the next step.

- "success": Items that passed condition (default)
- "filtered": Items that failed condition
- "all": Both success and filtered
"""


# =============================================================================
# STEP CONFIGURATIONS
# =============================================================================

@dataclass
class MapConfig(Generic[T]):
    """Map step configuration."""
    prompt: Prompt
    """Task prompt."""
    name: Optional[str] = None
    """Step name for observability (appears in events)."""
    system_prompt: Optional[str] = None
    """System prompt override."""
    schema: Optional[SchemaType] = None
    """Schema for structured output."""
    schema_options: Optional[Dict[str, Any]] = None
    """Validation options for JSON Schema."""
    agent: Optional[Any] = None
    """Agent override."""
    mcp_servers: Optional[Dict[str, Any]] = None
    """MCP servers override (replaces swarm default for this step)."""
    skills: Optional[List[str]] = None
    """Skills override (replaces swarm default for this step)."""
    composio: Optional[ComposioSetup] = None
    """Composio override (replaces swarm default for this step)."""
    best_of: Optional[BestOfConfig] = None
    """BestOf configuration (mutually exclusive with verify)."""
    verify: Optional[VerifyConfig] = None
    """Verify configuration (mutually exclusive with bestOf)."""
    retry: Optional[RetryConfig] = None
    """Retry configuration."""
    timeout_ms: Optional[int] = None
    """Timeout in ms."""


@dataclass
class FilterConfig(Generic[T]):
    """Filter step configuration."""
    prompt: str
    """Evaluation prompt."""
    schema: SchemaType
    """Schema for structured output (required)."""
    condition: Callable[[Any], bool]
    """Condition function to determine pass/fail."""
    name: Optional[str] = None
    """Step name for observability (appears in events)."""
    system_prompt: Optional[str] = None
    """System prompt override."""
    schema_options: Optional[Dict[str, Any]] = None
    """Validation options for JSON Schema."""
    agent: Optional[Any] = None
    """Agent override."""
    mcp_servers: Optional[Dict[str, Any]] = None
    """MCP servers override (replaces swarm default for this step)."""
    skills: Optional[List[str]] = None
    """Skills override (replaces swarm default for this step)."""
    composio: Optional[ComposioSetup] = None
    """Composio override (replaces swarm default for this step)."""
    emit: EmitOption = "success"
    """What to emit to next step (default: "success")."""
    verify: Optional[VerifyConfig] = None
    """Verify configuration."""
    retry: Optional[RetryConfig] = None
    """Retry configuration."""
    timeout_ms: Optional[int] = None
    """Timeout in ms."""


@dataclass
class ReduceConfig(Generic[T]):
    """Reduce step configuration."""
    prompt: str
    """Synthesis prompt."""
    name: Optional[str] = None
    """Step name for observability (appears in events)."""
    system_prompt: Optional[str] = None
    """System prompt override."""
    schema: Optional[SchemaType] = None
    """Schema for structured output."""
    schema_options: Optional[Dict[str, Any]] = None
    """Validation options for JSON Schema."""
    agent: Optional[Any] = None
    """Agent override."""
    mcp_servers: Optional[Dict[str, Any]] = None
    """MCP servers override (replaces swarm default for this step)."""
    skills: Optional[List[str]] = None
    """Skills override (replaces swarm default for this step)."""
    composio: Optional[ComposioSetup] = None
    """Composio override (replaces swarm default for this step)."""
    verify: Optional[VerifyConfig] = None
    """Verify configuration."""
    retry: Optional[RetryConfig] = None
    """Retry configuration."""
    timeout_ms: Optional[int] = None
    """Timeout in ms."""


# =============================================================================
# INTERNAL
# =============================================================================

StepType = Literal["map", "filter", "reduce"]


@dataclass
class Step:
    """Internal step representation."""
    type: StepType
    config: Union[MapConfig, FilterConfig, ReduceConfig]


# =============================================================================
# RESULTS
# =============================================================================

@dataclass
class StepResult(Generic[T]):
    """Result of a single pipeline step."""
    type: StepType
    index: int
    duration_ms: int
    results: Union[List[SwarmResult[T]], ReduceResult[T]]


@dataclass
class PipelineResult(Generic[T]):
    """Final result from pipeline execution."""
    pipeline_run_id: str
    """Unique identifier for this pipeline run."""
    steps: List[StepResult]
    output: Union[List[SwarmResult[T]], ReduceResult[T]]
    total_duration_ms: int


# =============================================================================
# EVENTS
# =============================================================================

@dataclass
class StepEvent:
    """Step lifecycle event (base class)."""
    type: StepType
    index: int
    name: Optional[str]


@dataclass
class StepStartEvent(StepEvent):
    """Emitted when step starts."""
    item_count: int


@dataclass
class StepCompleteEvent(StepEvent):
    """Emitted when step completes."""
    duration_ms: int
    success_count: int
    error_count: int
    filtered_count: int


@dataclass
class StepErrorEvent(StepEvent):
    """Emitted when step errors."""
    error: Exception


@dataclass
class ItemRetryEvent:
    """Emitted on item retry."""
    step_index: int
    step_name: Optional[str]
    item_index: int
    attempt: int
    error: str


@dataclass
class WorkerCompleteEvent:
    """Emitted when verify worker completes."""
    step_index: int
    step_name: Optional[str]
    item_index: int
    attempt: int
    status: Literal["success", "error"]


@dataclass
class VerifierCompleteEvent:
    """Emitted when verifier completes."""
    step_index: int
    step_name: Optional[str]
    item_index: int
    attempt: int
    passed: bool
    feedback: Optional[str]


@dataclass
class CandidateCompleteEvent:
    """Emitted when bestOf candidate completes."""
    step_index: int
    step_name: Optional[str]
    item_index: int
    candidate_index: int
    status: Literal["success", "error"]


@dataclass
class JudgeCompleteEvent:
    """Emitted when bestOf judge completes."""
    step_index: int
    step_name: Optional[str]
    item_index: int
    winner_index: int
    reasoning: str


@dataclass
class PipelineEvents:
    """Event handlers."""
    on_step_start: Optional[Callable[[StepStartEvent], None]] = None
    on_step_complete: Optional[Callable[[StepCompleteEvent], None]] = None
    on_step_error: Optional[Callable[[StepErrorEvent], None]] = None
    on_item_retry: Optional[Callable[[ItemRetryEvent], None]] = None
    on_worker_complete: Optional[Callable[[WorkerCompleteEvent], None]] = None
    on_verifier_complete: Optional[Callable[[VerifierCompleteEvent], None]] = None
    on_candidate_complete: Optional[Callable[[CandidateCompleteEvent], None]] = None
    on_judge_complete: Optional[Callable[[JudgeCompleteEvent], None]] = None


# Event name mapping for chainable .on() style
PipelineEventMap = {
    "step_start": "on_step_start",
    "step_complete": "on_step_complete",
    "step_error": "on_step_error",
    "item_retry": "on_item_retry",
    "worker_complete": "on_worker_complete",
    "verifier_complete": "on_verifier_complete",
    "candidate_complete": "on_candidate_complete",
    "judge_complete": "on_judge_complete",
}

# Event names (for type hints)
EventName = Literal[
    "step_start",
    "step_complete",
    "step_error",
    "item_retry",
    "worker_complete",
    "verifier_complete",
    "candidate_complete",
    "judge_complete",
]
