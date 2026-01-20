"""Result types for Swarm abstractions."""

from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Literal, Optional, TypeVar, Union

from .types import FileMap, IndexedMeta, ReduceMeta, JudgeMeta, VerifyMeta


T = TypeVar('T')

# Brand for runtime detection of SwarmResult (for chaining)
SWARM_RESULT_BRAND = "__swarm_result__"


# =============================================================================
# SWARM RESULT
# =============================================================================

@dataclass
class SwarmResult(Generic[T]):
    """Result from a single worker (map, filter, bestof candidate).

    Status meanings:
    - "success": Positive outcome (agent succeeded / condition passed)
    - "filtered": Neutral outcome (evaluated but didn't pass condition) - filter only
    - "error": Negative outcome (agent error)
    """
    status: Literal["success", "filtered", "error"]
    data: Optional[T]
    files: FileMap
    meta: IndexedMeta
    error: Optional[str] = None
    raw_data: Optional[str] = None
    best_of: Optional['BestOfInfo'] = None
    verify: Optional['VerifyInfo'] = None

    # Brand for runtime detection (used by is_swarm_result() function)
    __swarm_result__: bool = field(default=True, repr=False)


@dataclass
class BestOfInfo(Generic[T]):
    """BestOf information attached to SwarmResult when map used bestOf option."""
    winner_index: int
    judge_reasoning: str
    judge_meta: JudgeMeta
    candidates: List[SwarmResult[T]]


@dataclass
class VerifyInfo:
    """Verification info attached to results when verify option used."""
    passed: bool
    reasoning: str
    verify_meta: VerifyMeta
    attempts: int


# =============================================================================
# SWARM RESULT LIST
# =============================================================================

class SwarmResultList(List[SwarmResult[T]], Generic[T]):
    """List of SwarmResults with helper properties.

    Extends list so all normal list operations work.

    Getters:
    - `.success` - items with positive outcome
    - `.filtered` - items that didn't pass condition (filter only)
    - `.error` - items that encountered errors

    Chaining examples:
    - `swarm.reduce(results.success, ...)` - forward only successful
    - `swarm.reduce([*results.success, *results.filtered], ...)` - forward all evaluated
    """

    @property
    def success(self) -> List[SwarmResult[T]]:
        """Returns items with status 'success'."""
        return [r for r in self if r.status == "success"]

    @property
    def filtered(self) -> List[SwarmResult[T]]:
        """Returns items with status 'filtered' (didn't pass condition)."""
        return [r for r in self if r.status == "filtered"]

    @property
    def error(self) -> List[SwarmResult[T]]:
        """Returns items with status 'error'."""
        return [r for r in self if r.status == "error"]

    @classmethod
    def from_results(cls, results: List[SwarmResult[T]]) -> 'SwarmResultList[T]':
        """Create SwarmResultList from a list of SwarmResults."""
        result_list = cls()
        result_list.extend(results)
        return result_list


# =============================================================================
# REDUCE RESULT
# =============================================================================

@dataclass
class ReduceResult(Generic[T]):
    """Result from reduce operation."""
    status: Literal["success", "error"]
    data: Optional[T]
    files: FileMap
    meta: ReduceMeta
    error: Optional[str] = None
    raw_data: Optional[str] = None
    verify: Optional['VerifyInfo'] = None


# =============================================================================
# BESTOF RESULT
# =============================================================================

@dataclass
class BestOfResult(Generic[T]):
    """Result from bestOf operation."""
    winner: SwarmResult[T]
    winner_index: int
    judge_reasoning: str
    judge_meta: JudgeMeta
    candidates: List[SwarmResult[T]]


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def is_swarm_result(obj: Any) -> bool:
    """Check if an object is a SwarmResult (for chaining detection)."""
    return (
        isinstance(obj, SwarmResult) or
        (hasattr(obj, SWARM_RESULT_BRAND) and getattr(obj, SWARM_RESULT_BRAND) is True)
    )
