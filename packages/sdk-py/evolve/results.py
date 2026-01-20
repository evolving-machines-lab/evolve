"""Result types for Evolve SDK."""

from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Union


@dataclass
class AgentResponse:
    """Response from agent execution.

    Matches TypeScript SDK's AgentResponse for exact parity.

    Attributes:
        sandbox_id: Sandbox ID
        exit_code: Command exit code
        stdout: Standard output
        stderr: Standard error
    """
    sandbox_id: str
    exit_code: int
    stdout: str
    stderr: str


# Backward compatibility alias
ExecuteResult = AgentResponse


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
