"""Type definitions for Swarm abstractions."""

from dataclasses import dataclass
from typing import (
    Any,
    Callable,
    Dict,
    List,
    Literal,
    Optional,
    Type,
    TypeVar,
    Union,
)

from ..config import SandboxProvider, AgentConfig, WorkspaceMode, ComposioSetup
from ..retry import RetryConfig


# =============================================================================
# TYPE VARIABLES
# =============================================================================

T = TypeVar('T')

# =============================================================================
# FILE MAP
# =============================================================================

FileMap = Dict[str, Union[str, bytes]]

# =============================================================================
# CONFIGURATION
# =============================================================================

@dataclass
class SwarmConfig:
    """Configuration for Swarm instance.

    All fields are optional - TS SDK resolves defaults from environment:
    - agent defaults to EVOLVE_API_KEY env var with 'claude' type
    - sandbox defaults to E2B with E2B_API_KEY env var
    """
    agent: Optional[AgentConfig] = None
    sandbox: Optional[SandboxProvider] = None
    tag: str = "swarm"
    concurrency: int = 4
    timeout_ms: int = 3_600_000  # 1 hour
    workspace_mode: WorkspaceMode = "knowledge"
    retry: Optional[RetryConfig] = None
    """Default retry configuration for all operations (per-operation config takes precedence)."""
    mcp_servers: Optional[Dict[str, Any]] = None
    """Default MCP servers for all operations (per-operation config takes precedence)."""
    skills: Optional[List[str]] = None
    """Default skills for all operations (per-operation config takes precedence)."""
    composio: Optional[ComposioSetup] = None
    """Default Composio configuration for all operations (per-operation config takes precedence)."""


# Callback types for BestOf
OnCandidateCompleteCallback = Callable[[int, int, Literal["success", "error"]], None]
"""(item_index, candidate_index, status)"""

OnJudgeCompleteCallback = Callable[[int, int, str], None]
"""(item_index, winner_index, reasoning)"""


@dataclass
class BestOfConfig:
    """Configuration for bestOf operation."""
    judge_criteria: str
    n: Optional[int] = None
    task_agents: Optional[List[AgentConfig]] = None
    judge_agent: Optional[AgentConfig] = None
    mcp_servers: Optional[Dict[str, Any]] = None
    """MCP servers for candidates (defaults to operation mcp_servers)."""
    judge_mcp_servers: Optional[Dict[str, Any]] = None
    """MCP servers for judge (defaults to mcp_servers)."""
    skills: Optional[List[str]] = None
    """Skills for candidates (defaults to operation skills)."""
    judge_skills: Optional[List[str]] = None
    """Skills for judge (defaults to skills)."""
    composio: Optional[ComposioSetup] = None
    """Composio config for candidates (defaults to operation composio)."""
    judge_composio: Optional[ComposioSetup] = None
    """Composio config for judge (defaults to composio)."""
    on_candidate_complete: Optional[OnCandidateCompleteCallback] = None
    """Callback when a candidate completes."""
    on_judge_complete: Optional[OnJudgeCompleteCallback] = None
    """Callback when judge completes."""


# Callback types for Verify
OnWorkerCompleteCallback = Callable[[int, int, Literal["success", "error"]], None]
"""(item_index, attempt, status)"""

OnVerifierCompleteCallback = Callable[[int, int, bool, Optional[str]], None]
"""(item_index, attempt, passed, feedback)"""


@dataclass
class VerifyConfig:
    """Configuration for verify operation.

    Verify provides LLM-as-judge quality verification with retry loop.
    If verification fails, the worker is re-run with feedback from the verifier.
    """
    criteria: str
    """Verification criteria - what the output must satisfy."""
    max_attempts: int = 3
    """Maximum attempts with feedback (default: 3). Includes initial attempt."""
    verifier_agent: Optional[AgentConfig] = None
    """Optional: override agent for verifier."""
    verifier_mcp_servers: Optional[Dict[str, Any]] = None
    """MCP servers for verifier (defaults to operation mcp_servers)."""
    verifier_skills: Optional[List[str]] = None
    """Skills for verifier (defaults to operation skills)."""
    verifier_composio: Optional[ComposioSetup] = None
    """Composio config for verifier (defaults to operation composio)."""
    on_worker_complete: Optional[OnWorkerCompleteCallback] = None
    """Callback invoked after each worker completion (before verification)."""
    on_verifier_complete: Optional[OnVerifierCompleteCallback] = None
    """Callback invoked after each verifier completion."""


# =============================================================================
# METADATA
# =============================================================================

OperationType = Literal["map", "filter", "reduce", "bestof-cand", "bestof-judge", "verify"]


@dataclass
class BaseMeta:
    """Base metadata for all operations."""
    operation_id: str
    """Unique identifier for this operation."""
    operation: OperationType
    tag: str
    sandbox_id: str
    # Optional observability fields
    swarm_name: Optional[str] = None
    """Swarm name (from Swarm.config.tag) - identifies the swarm instance."""
    operation_name: Optional[str] = None
    """Operation name (from params.name) - user-defined label for this operation."""
    error_retry: Optional[int] = None
    """Error retry number (1, 2, 3...) - only present when retrying after error."""
    verify_retry: Optional[int] = None
    """Verify retry number (1, 2, 3...) - only present when retrying after verify failure."""
    candidate_index: Optional[int] = None
    """Candidate index (0, 1, 2...) - only present for bestOf candidates."""
    pipeline_run_id: Optional[str] = None
    """Pipeline run identifier - only present when run via Pipeline."""
    pipeline_step_index: Optional[int] = None
    """Pipeline step index - only present when run via Pipeline."""


@dataclass
class IndexedMeta(BaseMeta):
    """Metadata for indexed operations (map, filter, bestof-cand)."""
    item_index: int = 0
    """Item index in the batch (0, 1, 2...)."""


@dataclass
class ReduceMeta(BaseMeta):
    """Metadata for reduce operation."""
    input_count: int = 0
    input_indices: Optional[List[int]] = None

    def __post_init__(self):
        if self.input_indices is None:
            self.input_indices = []


@dataclass
class JudgeMeta(BaseMeta):
    """Metadata for bestOf judge."""
    candidate_count: int = 0


@dataclass
class VerifyMeta(BaseMeta):
    """Metadata for verify operation."""
    attempts: int = 0
    """Total verification attempts made."""


# =============================================================================
# PIPELINE CONTEXT (internal - passed from Pipeline to Swarm)
# =============================================================================

@dataclass
class PipelineContext:
    """Internal context passed from Pipeline to Swarm for observability."""
    pipeline_run_id: str
    pipeline_step_index: int


# =============================================================================
# PROMPT TYPES
# =============================================================================

PromptFn = Callable[[FileMap, int], str]
Prompt = Union[str, PromptFn]


# =============================================================================
# ITEM INPUT (for chaining)
# =============================================================================

# Forward reference - actual SwarmResult defined in results.py
# ItemInput can be a FileMap or a SwarmResult from a previous operation
ItemInput = Union[FileMap, Any]  # Any here will be SwarmResult at runtime


# =============================================================================
# SCHEMA TYPE
# =============================================================================

# Schema can be a Pydantic model, dataclass, or JSON Schema dict
SchemaType = Union[Type[Any], Dict[str, Any]]


# =============================================================================
# JUDGE DECISION
# =============================================================================

@dataclass
class JudgeDecision:
    """Fixed schema for bestOf judge output."""
    winner: int
    reasoning: str


@dataclass
class VerifyDecision:
    """Fixed schema for verify output."""
    passed: bool
    reasoning: str
    feedback: Optional[str] = None
