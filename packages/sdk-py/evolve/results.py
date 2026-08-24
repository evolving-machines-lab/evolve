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
        session_id: Dashboard session ID for trace/replay APIs, when known
        browser: Managed browser runtime info, when a remote browser is configured
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
    session_id: Optional[str] = None
    browser: Optional[Dict[str, str]] = None
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
    browser: Optional[Dict[str, str]] = None


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
        cost: Total cost in USD as billed to your Evolve account
        tokens: Token counts {'prompt': N, 'completion': N, 'cached': N}.
            ``prompt`` INCLUDES the cached share; ``cached`` is that share,
            absent on servers predating the field (never 0-by-default).
        model: Model used (e.g., 'claude-opus-4-8')
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
        total_tokens: Aggregate token counts
            {'prompt': N, 'completion': N, 'cached': N}. ``prompt`` INCLUDES
            the cached share; ``cached`` is absent on servers predating it.
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


@dataclass
class UsageReading:
    """THE ONE-HOME USAGE READING — "what has this run's meter said so far".

    Money and tokens come from the SAME gateway spend-log records, so the two
    can never describe different sets of requests. Served under the one key
    ``usage``, with these exact keys, by the trial surfaces and the
    managed-agents session surfaces alike — a renderer that reads one reads
    the other unchanged. While the run is alive the platform's own poll
    raises the numbers, so a polling reader sees them tick; once settled, the
    settled figures replace the live ones under the same keys. The whole
    object is None when the meter has never answered — never a fabricated
    zero.

    Attributes:
        provisional: True while every number is a LOWER BOUND that can still
            grow — the run is alive, or its settled lane is not yet
            confirmed. False = settled; the reading will not move again.
        spent_usd: Metered model spend so far, USD. None = the money was
            never measured (a trial's ``spend_source`` lane ``assumed_cap``;
            the token fields beside it may still carry real readings).
        input_tokens: Prompt tokens so far, INCLUDING the cached share.
        cached_input_tokens: The cached share of ``input_tokens``.
        output_tokens: Completion tokens so far.
        as_of: When this reading was taken — show its age, never the figure
            alone.
    """
    provisional: bool
    spent_usd: Optional[float]
    input_tokens: Optional[int]
    cached_input_tokens: Optional[int]
    output_tokens: Optional[int]
    as_of: Optional[str]


def _usage_reading_from_data(data: Any) -> Optional[UsageReading]:
    """The wire's usage reading, defensively — the same one rule as the
    TypeScript SDK's ``mapUsageReading``: anything malformed answers None
    (which already means "the meter never answered"), each numeric field is
    taken only as a real number, and ``provisional`` must be a real bool —
    without it the reading has no statement to make."""
    if not isinstance(data, dict):
        return None
    provisional = data.get('provisional')
    if not isinstance(provisional, bool):
        return None

    def _num(value: Any) -> Optional[float]:
        # bool is an int subclass; a stray True must never become money.
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    as_of = data.get('as_of')
    return UsageReading(
        provisional=provisional,
        spent_usd=_num(data.get('spent_usd')),
        input_tokens=_num(data.get('input_tokens')),
        cached_input_tokens=_num(data.get('cached_input_tokens')),
        output_tokens=_num(data.get('output_tokens')),
        as_of=as_of if isinstance(as_of, str) else None,
    )


SessionEvent = Dict[str, Any]


@dataclass
class SessionInfo:
    """Historical session metadata from the standalone sessions() client.

    Matches the TypeScript sessions() surface, with snake_case field names for
    Python transport ergonomics.
    """
    id: str
    tag: str
    agent: str
    model: Optional[str]
    provider: str
    sandbox_id: Optional[str]
    state: Literal['live', 'ended']
    runtime_status: Literal['alive', 'dead', 'unknown']
    cost: Optional[float]
    created_at: str
    ended_at: Optional[str]
    step_count: int
    tool_stats: Optional[Dict[str, int]]
    #: The one-home usage reading — the SAME object, same keys, a trial
    #: serves (see :class:`UsageReading`). None = the meter never answered
    #: (and on servers predating the field).
    usage: Optional[UsageReading] = None


@dataclass
class SessionPage:
    """Paginated session list response from the standalone sessions() client."""
    items: List[SessionInfo]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class BrowserReplay:
    """Browser replay metadata and Dashboard-owned access URLs."""
    session_id: str
    status: Literal['ready']
    replay_url: str
    download_url: str
    suggested_start_seconds: Optional[float] = None
    size_bytes: Optional[int] = None
    ready_at: Optional[str] = None
