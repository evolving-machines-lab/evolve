"""Result types for Evolve SDK."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Union


@dataclass
class CheckpointInfo:
    """Checkpoint metadata.

    Matches TypeScript SDK's CheckpointInfo for exact parity.
    Evidence: sdk-ts/src/types.ts lines 613-634

    Attributes:
        id: Checkpoint ID — pass as `from_checkpoint` to restore
        hash: SHA-256 of tar.gz — integrity verification
        tag: Session tag at checkpoint time — lineage tracking
        timestamp: ISO 8601 timestamp
        size_bytes: Archive size in bytes
        agent_type: Agent type that produced this checkpoint
        model: Model that produced this checkpoint
        workspace_mode: Workspace mode used when checkpoint was created
        parent_id: Parent checkpoint ID — lineage tracking
        comment: User-provided label for this checkpoint
    """
    id: str
    hash: str
    tag: str
    timestamp: str
    size_bytes: Optional[int] = None
    agent_type: Optional[str] = None
    model: Optional[str] = None
    workspace_mode: Optional[str] = None
    parent_id: Optional[str] = None
    comment: Optional[str] = None


@dataclass
class AgentResponse:
    """Response from agent execution.

    Matches TypeScript SDK's AgentResponse for exact parity.

    Attributes:
        sandbox_id: Sandbox ID
        run_id: Run ID for spend/cost attribution (present for run(), None for execute_command())
        exit_code: Command exit code
        stdout: Standard output
        stderr: Standard error
        checkpoint: Checkpoint info if storage configured and run succeeded
    """
    sandbox_id: str
    exit_code: int
    stdout: str
    stderr: str
    run_id: Optional[str] = None
    checkpoint: Optional[CheckpointInfo] = None


# Backward compatibility alias
ExecuteResult = AgentResponse


@dataclass
class SessionStatus:
    """Runtime status snapshot for sandbox and agent."""
    sandbox_id: Optional[str]
    sandbox: str
    agent: str
    active_process_id: Optional[str]
    has_run: bool
    timestamp: str


@dataclass
class OutputResult:
    """Result from get_output_files() with optional schema validation.

    Matches TypeScript SDK's OutputResult<T> for exact parity.
    Evidence: sdk-ts/src/types.ts lines 258-268

    Attributes:
        files: Output files from output/ folder
        data: Parsed and validated result.json data (None if no schema or validation failed)
        error: Validation or parse error message, if any
        raw_data: Raw result.json string when parse or validation failed (for debugging)
    """
    files: Dict[str, Union[str, bytes]] = field(default_factory=dict)
    data: Optional[Any] = None
    error: Optional[str] = None
    raw_data: Optional[str] = None


@dataclass
class RunCost:
    """Cost breakdown for a single run() invocation.

    Matches TypeScript SDK's RunCost for exact parity.

    Attributes:
        run_id: Run ID matching AgentResponse.run_id
        index: 1-based chronological position in session
        cost: Total cost in USD (includes platform margin)
        tokens: Token counts {'prompt': N, 'completion': N}
        model: Model used (e.g., 'claude-opus-4-6')
        requests: Number of LLM API requests in this run
        as_of: ISO timestamp when this data was fetched
        is_complete: False if recent LLM calls may still be batching (~60s delay)
        truncated: True if spend log pagination was capped
    """
    run_id: str
    index: int
    cost: float
    tokens: Dict[str, int]
    model: str
    requests: int
    as_of: str
    is_complete: bool
    truncated: bool


@dataclass
class SessionCost:
    """Cost breakdown for an entire agent session (all runs).

    Matches TypeScript SDK's SessionCost for exact parity.

    Attributes:
        session_tag: Session tag matching get_session_tag()
        total_cost: Total cost across all runs in USD
        total_tokens: Aggregate token counts {'prompt': N, 'completion': N}
        runs: Per-run breakdown, chronological order
        as_of: ISO timestamp when this data was fetched
        is_complete: False if session is still active or recently ended
        truncated: True if spend log pagination was capped
    """
    session_tag: str
    total_cost: float
    total_tokens: Dict[str, int]
    runs: List[RunCost]
    as_of: str
    is_complete: bool
    truncated: bool
