"""Hosted evals clients: standalone benchmarks() and evaluations().

Direct-HTTP clients against the dashboard API (same pattern as
browser_credentials.py — no Node bridge). Mirrors the TypeScript SDK's hosted
module 1-1: ``watch()`` consumes the server-sent event stream (replay from the
beginning, Last-Event-ID resume on reconnect, terminal-event completion), and
``watch_iter()`` is its async-iterator sibling yielding each
:class:`EvaluationEvent`.

API failures raise :class:`EvolveAPIError` — the server's product sentence as
the message plus the stable machine-readable ``code``.
"""

import asyncio
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Dict, List, Optional, Union

from .config import HostedClientConfig

DEFAULT_BASE_URL = 'https://dashboard.evolvingmachines.ai'

_TERMINAL_EVALUATION_STATUSES = {'COMPLETED', 'CANCELLED', 'FAILED'}

# Terminal import job statuses.
_TERMINAL_IMPORT_STATUSES = {'IMPORTED', 'FAILED'}

# Seeing one of these on the wire is the authoritative end-of-stream signal.
_TERMINAL_EVENT_TYPES = {'evaluation.completed', 'evaluation.cancelled', 'evaluation.failed'}

# camelCase -> snake_case boundary (only between a lower/digit and an upper,
# so all-caps status keys are never mangled).
_CAMEL_BOUNDARY = re.compile(r'(?<=[a-z0-9])(?=[A-Z])')


def _snake_key(key: str) -> str:
    return _CAMEL_BOUNDARY.sub('_', key).lower()


def _snake_keys(data: Any) -> Optional[Dict[str, Any]]:
    """Map a wire dict's camelCase keys to snake_case (None passes through)."""
    if not isinstance(data, dict):
        return None
    return {_snake_key(key): value for key, value in data.items()}


class EvolveAPIError(Exception):
    """A typed failure from the hosted evals API.

    ``message`` (``str(error)``) is the server's own product sentence; ``code``
    is the stable machine-readable identifier (e.g. ``benchmark_not_found``,
    ``version_not_ready``, ``provider_unsupported``, ``rate_limited``) so
    callers branch on codes, never on English. ``status`` is the HTTP status.
    """

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


class NoActiveVersionError(Exception):
    """Raised by ``benchmarks().get_active()`` when the benchmark has no active version.

    The benchmark exists but no version is active, so there is no runnable
    version to resolve. Use ``get()`` to inspect a benchmark that may not have
    an active version yet.
    """

    def __init__(self, name: str):
        super().__init__(f'Benchmark {name!r} has no active version')
        self.benchmark = name


# =============================================================================
# PUBLIC TYPES
# =============================================================================

@dataclass
class BenchmarkVersion:
    """One immutable version of a benchmark — one shape on every surface."""
    version: str
    state: str
    created_at: str
    task_count: int


@dataclass
class TaskProviderVerdict:
    """One provider's verdict for a task: runnable (ok), or refused with the limitation named."""
    ok: bool
    reason: Optional[str] = None


@dataclass
class Task:
    """Public task fields only — instructions/environments/tests never leave the server.

    ``providers`` maps each sandbox provider to a :class:`TaskProviderVerdict`.
    Advisory for choosing an evaluation's provider — creating an evaluation
    whose tasks include one refused on the chosen provider is rejected with
    the same reason, so nothing is ever spent on a run that cannot execute.
    """
    task_key: str
    agent_timeout_sec: int
    verifier_timeout_sec: int
    providers: Dict[str, TaskProviderVerdict]


@dataclass
class Benchmark:
    """A benchmark in the shared catalog.

    list() returns the summary fields; get() additionally populates versions,
    selected_version, tasks, created_at, and updated_at.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: Optional[BenchmarkVersion]
    versions: Optional[List[BenchmarkVersion]] = None
    # The version whose tasks are listed (get() only)
    selected_version: Optional[BenchmarkVersion] = None
    tasks: Optional[List[Task]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class ActiveBenchmark:
    """A benchmark's active version resolved to a runnable shape.

    Unlike :class:`Benchmark`, ``version`` and ``tasks`` are non-optional:
    ``get_active()`` raises :class:`NoActiveVersionError` when there is no
    active version, so callers never branch on a missing active version.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: BenchmarkVersion
    version: str
    tasks: List[Task]
    versions: List[BenchmarkVersion]
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class AgentSystem:
    harness: str
    model: str
    harness_version: Optional[str] = None

    def _to_wire(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'harness': self.harness, 'model': self.model}
        if self.harness_version is not None:
            result['harnessVersion'] = self.harness_version
        return result


@dataclass
class EvaluationCounts:
    """Evaluation size: agent_systems x tasks -> task_runs (present on every shape)."""
    agent_systems: int
    tasks: int
    task_runs: int


@dataclass
class Evaluation:
    """An evaluation = tasks x agent systems x runs_per_task."""
    id: str
    status: str
    # "name@version"
    benchmark: str
    runs_per_task: int
    concurrency: int
    max_model_spend_usd: float
    #: Sandbox provider this evaluation runs on ("e2b" | "daytona" | "modal").
    sandbox_provider: str
    spent_usd: float
    counts: EvaluationCounts
    created_at: str
    # Per-task-run model-spend cap, when one was set
    max_model_spend_usd_per_task_run: Optional[float] = None
    task_run_counts: Optional[Dict[str, int]] = None
    # Mean score over SCORED runs only; None when none. Zero is a score. (get/list)
    mean_score: Optional[float] = None
    agent_systems: Optional[List[AgentSystem]] = None
    error: Optional[str] = None
    updated_at: Optional[str] = None
    source_evaluation_id: Optional[str] = None
    idempotent_replay: bool = False


@dataclass
class ModelUsage:
    """Model usage/spend recorded for a task run — purely spend/usage, in the
    one money vocabulary (caps are max_model_spend*, actuals are spent_usd).

    ``spend_source`` is "measured" (measured model spend reported by the
    platform) or "assumed_cap" (spend could not be measured for this run, so
    the per-run cap is reported). Harness-specific keys land in ``extra`` with
    snake_case keys.
    """
    spent_usd: Optional[float] = None
    spend_source: Optional[str] = None
    # The per-run model-spend cap that applied to this run
    max_model_spend_usd: Optional[float] = None
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TaskRun:
    """One task x one agent system x one run_number (1-based)."""
    id: str
    task_key: str
    agent_system: AgentSystem
    run_number: int
    status: str
    score: Optional[float]
    metrics: Optional[Dict[str, float]]
    failure_phase: Optional[str]
    failure_detail: Optional[str]
    # Wall-clock per phase with snake_case keys, e.g. {"agent_ms", "verify_ms"}
    phase_timings_ms: Optional[Dict[str, float]]
    model_usage: Optional[ModelUsage]
    # Sandbox provider the run executed on; None until it has executed
    sandbox_provider: Optional[str]
    # Where the verifier ran ("separate" pristine box | "shared" inside the
    # agent box); None until recorded
    verifier_mode: Optional[str]
    # Harness version actually resolved and used for the run; None until resolved
    resolved_harness_version: Optional[str]
    session_ref: Optional[str]
    created_at: str
    updated_at: str


@dataclass
class TaskRunDetail(TaskRun):
    """Full detail of one task run — evaluations().task_run(id, run_id).

    Same shape as a list row, plus the owning evaluation; unlike list rows,
    failure_detail is untruncated here.
    """
    evaluation_id: str


@dataclass
class EvaluationEvent:
    """One server-sent event from evaluations().watch()/watch_iter()."""
    # Monotonic sequence number (SSE id; the Last-Event-ID resume position)
    seq: int
    # Event type, e.g. "evaluation.created", "task_run.settled", "evaluation.completed"
    type: str
    data: Dict[str, Any]


@dataclass
class TaskRunTraceEvent:
    """One trace event of a task run (seq-ordered timeline)."""
    seq: int
    type: str
    data: Dict[str, Any]


@dataclass
class TaskRunTracePage:
    """One seq-paged slice of a task run's trace — evaluations().task_run_trace()."""
    events: List[TaskRunTraceEvent]
    # Resume position: pass back as after= to continue. An empty page echoes
    # the requested position (None when reading an empty trace from the start).
    next_after: Optional[int]


@dataclass
class ComparisonCoverage:
    """Scored-run coverage behind an aggregate (means cover SCORED runs only)."""
    scored: int
    total: int


@dataclass
class ComparisonCell:
    """One (task_key x evaluation) cell of the compare matrix.

    status is the shared TaskRun status when the cell's runs agree, "MIXED"
    when they differ, and "MISSING" when the evaluation has no runs for the task.
    """
    evaluation_id: str
    status: str
    # Mean score over the cell's SCORED runs; None when none. Zero is a score.
    mean_score: Optional[float]
    coverage: ComparisonCoverage


@dataclass
class ComparisonTaskRow:
    """One matrix row of evaluations().compare(): a task across the compared evaluations."""
    task_key: str
    # True when the evaluations' cells differ in status or score for this task
    disagreement: bool
    # Cells in the caller's evaluation-id order
    cells: List[ComparisonCell]


@dataclass
class ComparisonAggregate:
    """Per-evaluation aggregate of evaluations().compare()."""
    id: str
    benchmark: str
    status: str
    # Mean score over SCORED runs only; None when none. Zero is a score.
    mean_score: Optional[float]
    coverage: ComparisonCoverage
    spent_usd: float
    agent_systems: List[AgentSystem]
    created_at: str


@dataclass
class EvaluationComparison:
    """Result of evaluations().compare([ids]): aggregates + per-task matrix."""
    # Aggregates in the caller's id order
    evaluations: List[ComparisonAggregate]
    # Per-task matrix, disagreement rows first
    task_matrix: List[ComparisonTaskRow]


@dataclass
class RegradeResult:
    """One regrade of one source task run: the verifier re-run against that run's
    RECORDED inputs, in a fresh separate verifier box. The agent phase is never
    re-run and the source run is never modified — ``source_score``/
    ``source_status`` are immutable snapshots taken when the regrade was created.
    """
    id: str
    source_task_run_id: str
    task_key: str
    status: str
    score: Optional[float]
    metrics: Optional[Dict[str, float]]
    source_score: Optional[float]
    source_status: str
    # score − source_score when both are real numbers, else None (Harbor delta)
    score_delta: Optional[float]
    # Where the verifier ran — always "separate" (regrade only re-runs separate)
    verifier_mode: str
    # Content digest of the resolved target verifier spec = the "verifier
    # version"; equal to the source run's own verifier means a reproduce.
    verifier_digest: Optional[str]
    verifier_sandbox_id: Optional[str]
    failure_phase: Optional[str]
    failure_detail: Optional[str]
    phase_timings_ms: Optional[Dict[str, float]]
    created_at: str
    settled_at: Optional[str]


@dataclass
class RegradeFilter:
    """The filter applied when selecting source runs for a per-evaluation regrade."""
    status: Optional[List[str]] = None
    task_key: Optional[str] = None


@dataclass
class RegradeJobCounts:
    """Regrade job size: total results + a histogram by regrade status."""
    results: int
    by_status: Dict[str, int]


@dataclass
class RegradeJob:
    """A regrade job = a collection of regrade results.

    A per-task-run regrade holds one result; a per-evaluation regrade holds one
    per eligible source run. ``status`` is derived from the results
    ("QUEUED"|"RUNNING"|"COMPLETED"). ``results`` is present on read + create.
    """
    id: str
    source_evaluation_id: str
    status: str
    sandbox_provider: str
    counts: RegradeJobCounts
    created_at: str
    updated_at: str
    filter: Optional[RegradeFilter] = None
    results: Optional[List[RegradeResult]] = None


@dataclass
class BenchmarkImportFailure:
    """One task that failed to parse or validate during an import."""
    task_key: str
    error: str


@dataclass
class BenchmarkImportError:
    """Structured failure detail for a FAILED import."""
    # What went wrong, e.g. "2/113 task(s) failed to parse"
    message: str
    # Per-task parse/validation failures, when the corpus was reachable
    failures: List[BenchmarkImportFailure] = field(default_factory=list)


@dataclass
class BenchmarkImport:
    """A benchmark import job.

    Terminal statuses: "IMPORTED" (the corpus landed as a benchmark version;
    it becomes runnable once the platform activates it) and "FAILED".
    Self-describing: every response names the benchmark@version being imported.
    """
    id: str
    # Job status: "IMPORTING" | "IMPORTED" | "FAILED"
    status: str
    # Catalog benchmark name the import creates or extends
    benchmark_name: str
    # Version label of the imported version
    version: str
    # Failure detail when status is "FAILED"
    error: Optional[BenchmarkImportError] = None
    # Number of tasks parsed, once counted (get_import() responses)
    task_count: Optional[int] = None


@dataclass
class EvaluationPage:
    evaluations: List[Evaluation]
    next_cursor: Optional[str]


@dataclass
class TaskRunPage:
    task_runs: List[TaskRun]
    next_cursor: Optional[str]


# =============================================================================
# MAPPERS
# =============================================================================

def _map_agent_system(data: Dict[str, Any]) -> AgentSystem:
    # Map only the public AgentSystem fields.
    return AgentSystem(
        harness=data.get('harness', ''),
        model=data.get('model', ''),
        harness_version=data.get('harnessVersion'),
    )


def _map_benchmark_version(data: Dict[str, Any]) -> BenchmarkVersion:
    return BenchmarkVersion(
        version=data['version'],
        state=data.get('state', ''),
        created_at=data.get('createdAt', ''),
        task_count=int(data.get('taskCount', 0)),
    )


def _map_task(data: Dict[str, Any]) -> Task:
    providers_raw = data.get('providers') or {}
    return Task(
        task_key=data['taskKey'],
        agent_timeout_sec=int(data.get('agentTimeoutSec', 0)),
        verifier_timeout_sec=int(data.get('verifierTimeoutSec', 0)),
        providers={
            provider: TaskProviderVerdict(
                ok=bool(verdict.get('ok')),
                reason=verdict.get('reason'),
            )
            for provider, verdict in providers_raw.items()
            if isinstance(verdict, dict)
        },
    )


def _map_counts(data: Any) -> EvaluationCounts:
    counts = data if isinstance(data, dict) else {}
    return EvaluationCounts(
        agent_systems=int(counts.get('agentSystems', 0)),
        tasks=int(counts.get('tasks', 0)),
        task_runs=int(counts.get('taskRuns', 0)),
    )


def _map_evaluation(data: Dict[str, Any]) -> Evaluation:
    agent_systems = data.get('agentSystems')
    return Evaluation(
        id=data['id'],
        status=data.get('status', ''),
        benchmark=data.get('benchmark', ''),
        runs_per_task=int(data.get('runsPerTask', 0)),
        concurrency=int(data.get('concurrency', 0)),
        max_model_spend_usd=float(data.get('maxModelSpendUsd', 0)),
        sandbox_provider=data.get('sandboxProvider', ''),
        spent_usd=float(data.get('spentUsd', 0)),
        counts=_map_counts(data.get('counts')),
        created_at=data.get('createdAt', ''),
        max_model_spend_usd_per_task_run=data.get('maxModelSpendUsdPerTaskRun'),
        task_run_counts=data.get('taskRunCounts'),
        mean_score=data.get('meanScore'),
        agent_systems=(
            [_map_agent_system(item) for item in agent_systems]
            if isinstance(agent_systems, list)
            else None
        ),
        error=data.get('error'),
        updated_at=data.get('updatedAt'),
        source_evaluation_id=data.get('sourceEvaluationId'),
        idempotent_replay=bool(data.get('idempotentReplay', False)),
    )


_MODEL_USAGE_WIRE_KEYS = {'spentUsd', 'spendSource', 'maxModelSpendUsd'}


def _map_model_usage(data: Any) -> Optional[ModelUsage]:
    if not isinstance(data, dict):
        return None
    return ModelUsage(
        spent_usd=data.get('spentUsd'),
        spend_source=data.get('spendSource'),
        max_model_spend_usd=data.get('maxModelSpendUsd'),
        extra={
            _snake_key(key): value
            for key, value in data.items()
            if key not in _MODEL_USAGE_WIRE_KEYS
        },
    )


def _map_task_run(data: Dict[str, Any]) -> TaskRun:
    return TaskRun(
        id=data['id'],
        task_key=data.get('taskKey', ''),
        agent_system=_map_agent_system(data.get('agentSystem') or {}),
        run_number=int(data.get('runNumber', 0)),
        status=data.get('status', ''),
        score=data.get('score'),
        metrics=data.get('metrics'),
        failure_phase=data.get('failurePhase'),
        failure_detail=data.get('failureDetail'),
        phase_timings_ms=_snake_keys(data.get('phaseTimingsMs')),
        model_usage=_map_model_usage(data.get('modelUsage')),
        sandbox_provider=data.get('sandboxProvider'),
        verifier_mode=data.get('verifierMode'),
        resolved_harness_version=data.get('resolvedHarnessVersion'),
        session_ref=data.get('sessionRef'),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
    )


def _map_task_run_detail(data: Dict[str, Any]) -> TaskRunDetail:
    base = _map_task_run(data)
    return TaskRunDetail(
        **base.__dict__,
        evaluation_id=data.get('evaluationId', ''),
    )


def _map_trace_event(data: Dict[str, Any]) -> TaskRunTraceEvent:
    return TaskRunTraceEvent(
        seq=int(data.get('seq', -1)),
        type=data.get('type', ''),
        data=data.get('data') or {},
    )


def _map_coverage(data: Any) -> ComparisonCoverage:
    data = data if isinstance(data, dict) else {}
    return ComparisonCoverage(
        scored=int(data.get('scored', 0)),
        total=int(data.get('total', 0)),
    )


def _map_comparison_aggregate(data: Dict[str, Any]) -> ComparisonAggregate:
    agent_systems = data.get('agentSystems')
    return ComparisonAggregate(
        id=data.get('id', ''),
        benchmark=data.get('benchmark', ''),
        status=data.get('status', ''),
        mean_score=data.get('meanScore'),
        coverage=_map_coverage(data.get('coverage')),
        spent_usd=float(data.get('spentUsd', 0)),
        agent_systems=(
            [_map_agent_system(item) for item in agent_systems]
            if isinstance(agent_systems, list)
            else []
        ),
        created_at=data.get('createdAt', ''),
    )


def _map_comparison_cell(data: Dict[str, Any]) -> ComparisonCell:
    return ComparisonCell(
        evaluation_id=data.get('evaluationId', ''),
        status=data.get('status', ''),
        mean_score=data.get('meanScore'),
        coverage=_map_coverage(data.get('coverage')),
    )


def _map_comparison_task_row(data: Dict[str, Any]) -> ComparisonTaskRow:
    return ComparisonTaskRow(
        task_key=data.get('taskKey', ''),
        disagreement=bool(data.get('disagreement', False)),
        cells=[_map_comparison_cell(item) for item in data.get('cells', [])],
    )


def _map_import_error(data: Any) -> Optional[BenchmarkImportError]:
    if not isinstance(data, dict):
        return None
    return BenchmarkImportError(
        message=data.get('message', ''),
        failures=[
            BenchmarkImportFailure(
                task_key=item.get('taskKey', ''),
                error=item.get('error', ''),
            )
            for item in data.get('failures', [])
            if isinstance(item, dict)
        ],
    )


def _map_regrade_result(data: Dict[str, Any]) -> RegradeResult:
    return RegradeResult(
        id=data['id'],
        source_task_run_id=data.get('sourceTaskRunId', ''),
        task_key=data.get('taskKey', ''),
        status=data.get('status', ''),
        score=data.get('score'),
        metrics=data.get('metrics'),
        source_score=data.get('sourceScore'),
        source_status=data.get('sourceStatus', ''),
        score_delta=data.get('scoreDelta'),
        verifier_mode=data.get('verifierMode', 'separate'),
        verifier_digest=data.get('verifierDigest'),
        verifier_sandbox_id=data.get('verifierSandboxId'),
        failure_phase=data.get('failurePhase'),
        failure_detail=data.get('failureDetail'),
        phase_timings_ms=_snake_keys(data.get('phaseTimingsMs')),
        created_at=data.get('createdAt', ''),
        settled_at=data.get('settledAt'),
    )


def _map_regrade_filter(data: Any) -> Optional[RegradeFilter]:
    if not isinstance(data, dict):
        return None
    return RegradeFilter(status=data.get('status'), task_key=data.get('taskKey'))


def _map_regrade_job(data: Dict[str, Any]) -> RegradeJob:
    counts = data.get('counts') if isinstance(data.get('counts'), dict) else {}
    results = data.get('results')
    return RegradeJob(
        id=data['id'],
        source_evaluation_id=data.get('sourceEvaluationId', ''),
        status=data.get('status', ''),
        sandbox_provider=data.get('sandboxProvider', ''),
        counts=RegradeJobCounts(
            results=int(counts.get('results', 0)),
            by_status=counts.get('byStatus') or {},
        ),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
        filter=_map_regrade_filter(data.get('filter')),
        results=(
            [_map_regrade_result(item) for item in results]
            if isinstance(results, list)
            else None
        ),
    )


def _map_benchmark_import(data: Dict[str, Any]) -> BenchmarkImport:
    benchmark_import = BenchmarkImport(
        id=data.get('id', ''),
        status=data.get('status', ''),
        benchmark_name=data.get('benchmarkName', ''),
        version=data.get('version', ''),
    )
    if 'error' in data:
        benchmark_import.error = _map_import_error(data.get('error'))
    if isinstance(data.get('taskCount'), int):
        benchmark_import.task_count = data.get('taskCount')
    return benchmark_import


# =============================================================================
# HTTP CORE
# =============================================================================

def _parse_error_body(text: str, fallback: str) -> 'tuple[str, str]':
    """Extract (code, message) from a hosted error body {error: {code, message}}."""
    try:
        body = json.loads(text)
    except ValueError:
        return 'unknown_error', text or fallback
    error = body.get('error') if isinstance(body, dict) else None
    if isinstance(error, dict):
        code = error.get('code') if isinstance(error.get('code'), str) else 'unknown_error'
        message = error.get('message') if isinstance(error.get('message'), str) else fallback
        return code, message
    return 'unknown_error', text or fallback


def _raise_api_error(exc: urllib.error.HTTPError) -> None:
    detail = exc.read().decode('utf-8', errors='replace')
    code, message = _parse_error_body(detail, str(exc.reason))
    raise EvolveAPIError(exc.code, code, message) from exc


class _HostedHttp:
    def __init__(self, factory: str, config: Optional[HostedClientConfig]):
        self._factory = factory
        self._config = config or HostedClientConfig()

    def base_url(self) -> str:
        return (
            self._config.base_url
            or os.environ.get('EVOLVE_DASHBOARD_URL')
            or DEFAULT_BASE_URL
        ).rstrip('/')

    def api_key(self) -> str:
        api_key = self._config.api_key or os.environ.get('EVOLVE_API_KEY')
        if not api_key:
            raise ValueError(
                f'{self._factory}() requires an API key. Set EVOLVE_API_KEY or '
                'pass HostedClientConfig(api_key=...).'
            )
        return api_key

    async def request_json(
        self,
        path: str,
        method: str = 'GET',
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        return await asyncio.to_thread(self._request_sync, path, method, body, headers, False)

    async def request_bytes(self, path: str) -> 'tuple[bytes, Dict[str, str]]':
        return await asyncio.to_thread(self._request_sync, path, 'GET', None, None, True)

    async def download(self, path: str, to_dir: str, default_filename: str) -> str:
        return await asyncio.to_thread(self._download_sync, path, to_dir, default_filename)

    def _request_sync(
        self,
        path: str,
        method: str,
        body: Optional[Dict[str, Any]],
        headers: Optional[Dict[str, str]],
        raw: bool,
    ):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        request_headers = {
            'Authorization': f'Bearer {self.api_key()}',
            'Accept': 'application/json',
        }
        if data is not None:
            request_headers['Content-Type'] = 'application/json'
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            f'{self.base_url()}{path}',
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = response.read()
                if raw:
                    return payload, dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
        if not payload:
            return {}
        return json.loads(payload.decode('utf-8'))

    def _download_sync(self, path: str, to_dir: str, default_filename: str) -> str:
        """Stream a download straight to disk — never buffers the archive in memory."""
        request = urllib.request.Request(
            f'{self.base_url()}{path}',
            headers={'Authorization': f'Bearer {self.api_key()}'},
        )
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                os.makedirs(to_dir, exist_ok=True)
                disposition = response.headers.get('Content-Disposition', '') or ''
                match = re.search(r'filename="([^"]+)"', disposition)
                filename = match.group(1) if match else default_filename
                target = os.path.join(to_dir, filename)
                with open(target, 'wb') as f:
                    shutil.copyfileobj(response, f)
                return target
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
            raise  # unreachable; _raise_api_error always raises


# =============================================================================
# PAGINATION (awaitable + async-iterable)
# =============================================================================

class _PaginatedList:
    """A cursor-paged result that is both awaitable and async-iterable.

    ``await`` resolves the first page, honoring the caller's ``limit``/``cursor``
    (the original page form). ``async for`` walks every row across pages,
    following ``next_cursor`` from the caller's starting cursor.
    """

    def __init__(self, fetch_page, rows_of, *, limit=None, cursor=None):
        # fetch_page: async (limit, cursor) -> page
        self._fetch_page = fetch_page
        self._rows_of = rows_of
        self._limit = limit
        self._cursor = cursor

    def __await__(self):
        return self._fetch_page(self._limit, self._cursor).__await__()

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        cursor = self._cursor
        while True:
            page = await self._fetch_page(self._limit, cursor)
            for row in self._rows_of(page):
                yield row
            if not page.next_cursor:
                return
            cursor = page.next_cursor


# =============================================================================
# BENCHMARKS CLIENT
# =============================================================================

class BenchmarksClient:
    """Client for the shared benchmark catalog.

    Created via the standalone ``benchmarks()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    Example::

        from evolve import benchmarks

        async with benchmarks() as b:
            catalog = await b.list()
            deep_swe = await b.get('deep-swe@1.1')
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('benchmarks', config)

    async def __aenter__(self) -> 'BenchmarksClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def list(self) -> List[Benchmark]:
        """List every benchmark with its active version."""
        data = await self._http.request_json('/api/benchmarks')
        result: List[Benchmark] = []
        for raw in data.get('benchmarks', []):
            active = raw.get('activeVersion')
            result.append(Benchmark(
                name=raw['name'],
                title=raw.get('title'),
                description=raw.get('description'),
                active_version=_map_benchmark_version(active) if active else None,
            ))
        return result

    async def get(self, ref: str) -> Benchmark:
        """Get one benchmark: all versions + the selected version's task list.

        ``ref`` is ``"name"`` (active version's tasks) or ``"name@version"``.
        """
        name, ref_version = _parse_benchmark_ref(ref)
        query = f'?version={urllib.parse.quote(ref_version)}' if ref_version is not None else ''
        raw = await self._http.request_json(
            f'/api/benchmarks/{urllib.parse.quote(name)}{query}'
        )
        active = raw.get('activeVersion')
        selected = raw.get('selectedVersion')
        return Benchmark(
            name=raw['name'],
            title=raw.get('title'),
            description=raw.get('description'),
            active_version=_map_benchmark_version(active) if active else None,
            versions=[_map_benchmark_version(item) for item in raw.get('versions', [])],
            selected_version=_map_benchmark_version(selected) if selected else None,
            tasks=[_map_task(item) for item in raw.get('tasks', [])],
            created_at=raw.get('createdAt'),
            updated_at=raw.get('updatedAt'),
        )

    async def get_active(self, name: str) -> ActiveBenchmark:
        """Get a benchmark's active version resolved to a runnable shape.

        Unlike :meth:`get`, ``version`` and ``tasks`` are guaranteed present.
        Raises :class:`NoActiveVersionError` when the benchmark has no active
        version. Use :meth:`get` for the full multi-version detail.
        """
        bench = await self.get(name)
        if bench.active_version is None:
            raise NoActiveVersionError(name)
        return ActiveBenchmark(
            name=bench.name,
            title=bench.title,
            description=bench.description,
            active_version=bench.active_version,
            version=bench.active_version.version,
            tasks=bench.tasks or [],
            versions=bench.versions or [],
            created_at=bench.created_at,
            updated_at=bench.updated_at,
        )

    async def import_benchmark(
        self,
        *,
        git_url: str,
        ref: str,
        benchmark_name: str,
        version: str,
    ) -> BenchmarkImport:
        """Start a benchmark import job from a git source pinned to a ref.

        Returns immediately; poll with :meth:`get_import` /
        :meth:`watch_import`. ``version`` labels the imported benchmark
        version.
        """
        if not git_url or not ref:
            raise ValueError(
                'import_benchmark() requires a git source: '
                'git_url=..., ref=... plus benchmark_name=... and version=...'
            )
        body: Dict[str, Any] = {
            'source': {'type': 'git', 'url': git_url, 'ref': ref},
            'benchmarkName': benchmark_name,
            'version': version,
        }
        raw = await self._http.request_json('/api/benchmarks/imports', method='POST', body=body)
        return _map_benchmark_import(raw)

    async def get_import(self, id: str) -> BenchmarkImport:
        """Get an import job's status (error and task_count when available)."""
        raw = await self._http.request_json(
            f'/api/benchmarks/imports/{urllib.parse.quote(id)}'
        )
        return _map_benchmark_import(raw)

    async def watch_import(
        self,
        id: str,
        *,
        on_status: Optional[Callable[[BenchmarkImport], None]] = None,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
    ) -> BenchmarkImport:
        """Poll ``get_import()`` until the job reaches a terminal status.

        Terminal statuses: "IMPORTED" or "FAILED" (``error`` populated).
        ``on_status`` fires on every observed status change, including the
        first status seen.
        """
        if poll_interval_s <= 0:
            raise ValueError('poll_interval_s must be positive')
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        last_status: Optional[str] = None
        while True:
            benchmark_import = await self.get_import(id)
            if benchmark_import.status != last_status:
                last_status = benchmark_import.status
                if on_status is not None:
                    on_status(benchmark_import)
            if benchmark_import.status in _TERMINAL_IMPORT_STATUSES:
                return benchmark_import
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch_import({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)


# =============================================================================
# SSE WATCH SUPPORT
# =============================================================================

class _SseConnection:
    """Holder for one open SSE response so the async side can close it."""

    def __init__(self):
        self.response = None

    def close(self) -> None:
        response = self.response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _parse_sse_data(text: str) -> Dict[str, Any]:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except ValueError:
        return {'raw': text}
    return parsed if isinstance(parsed, dict) else {'value': parsed}


# =============================================================================
# EVALUATIONS CLIENT
# =============================================================================

class EvaluationsClient:
    """Client for hosted evaluations.

    Created via the standalone ``evaluations()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    ``watch()`` consumes the server-sent event stream (replay + live,
    Last-Event-ID resume on reconnect) and resolves with the final evaluation;
    ``watch_iter()`` yields each :class:`EvaluationEvent` instead.

    Example::

        from evolve import evaluations, AgentSystem

        async with evaluations() as e:
            evaluation = await e.run(
                benchmark='deep-swe@1.1',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                max_model_spend_usd=25,
            )
            final = await e.watch(evaluation.id)
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('evaluations', config)

    async def __aenter__(self) -> 'EvaluationsClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def run(
        self,
        *,
        benchmark: str,
        tasks: Optional[List[str]] = None,
        agent_systems: List[Union[AgentSystem, Dict[str, Any]]],
        runs_per_task: Optional[int] = None,
        concurrency: Optional[int] = None,
        max_model_spend_usd: float,
        max_model_spend_usd_per_task_run: Optional[float] = None,
        sandbox_provider: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Evaluation:
        """Create an evaluation.

        ``benchmark`` is ``"name"`` (resolved server-side to the active READY
        version) or ``"name@version"``; the response always echoes
        ``"name@version"``. ``agent_systems`` accepts :class:`AgentSystem`
        instances or plain dicts with the same fields (``harness``, ``model``,
        optional ``harness_version``). Supports Idempotency-Key.
        """
        body: Dict[str, Any] = {'benchmark': benchmark}
        if tasks is not None:
            body['tasks'] = tasks
        body['agentSystems'] = [
            (system if isinstance(system, AgentSystem) else AgentSystem(**system))._to_wire()
            for system in agent_systems
        ]
        if runs_per_task is not None:
            body['runsPerTask'] = runs_per_task
        if concurrency is not None:
            body['concurrency'] = concurrency
        body['maxModelSpendUsd'] = max_model_spend_usd
        if max_model_spend_usd_per_task_run is not None:
            body['maxModelSpendUsdPerTaskRun'] = max_model_spend_usd_per_task_run
        if sandbox_provider is not None:
            body['sandboxProvider'] = sandbox_provider
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json('/api/evaluations', method='POST', body=body, headers=headers)
        return _map_evaluation(raw)

    async def get(self, id: str) -> Evaluation:
        """Get one evaluation with agent systems + task-run status counts."""
        raw = await self._http.request_json(f'/api/evaluations/{urllib.parse.quote(id)}')
        return _map_evaluation(raw)

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List the caller's evaluations, newest first (cursor-paged).

        ``await`` the result for one page (honoring ``limit``/``cursor``), or
        ``async for`` it to walk every evaluation across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> EvaluationPage:
            params: Dict[str, str] = {}
            if page_limit is not None:
                params['limit'] = str(page_limit)
            if page_cursor is not None:
                params['cursor'] = page_cursor
            query = urllib.parse.urlencode(params)
            raw = await self._http.request_json(
                f'/api/evaluations{("?" + query) if query else ""}'
            )
            return EvaluationPage(
                evaluations=[_map_evaluation(item) for item in raw.get('evaluations', [])],
                next_cursor=raw.get('nextCursor'),
            )

        return _PaginatedList(
            fetch_page, lambda page: page.evaluations, limit=limit, cursor=cursor
        )

    def task_runs(
        self,
        id: str,
        *,
        status: Optional[List[str]] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List an evaluation's task runs (cursor-paged).

        ``status`` filters to the given statuses (e.g. the failures behind a
        rerun decision). ``await`` the result for one page (honoring
        ``limit``/``cursor``), or ``async for`` it to walk every task run
        across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> TaskRunPage:
            params: Dict[str, str] = {}
            if status:
                params['status'] = ','.join(status)
            if page_limit is not None:
                params['limit'] = str(page_limit)
            if page_cursor is not None:
                params['cursor'] = page_cursor
            query = urllib.parse.urlencode(params)
            raw = await self._http.request_json(
                f'/api/evaluations/{urllib.parse.quote(id)}/task-runs{("?" + query) if query else ""}'
            )
            return TaskRunPage(
                task_runs=[_map_task_run(item) for item in raw.get('taskRuns', [])],
                next_cursor=raw.get('nextCursor'),
            )

        return _PaginatedList(
            fetch_page, lambda page: page.task_runs, limit=limit, cursor=cursor
        )

    # ------------------------------------------------------------------ watch

    def _read_sse_sync(
        self,
        id: str,
        last_seq: Optional[int],
        loop: asyncio.AbstractEventLoop,
        queue: 'asyncio.Queue',
        connection: _SseConnection,
    ) -> None:
        """Blocking SSE reader (runs in a worker thread): pushes parsed events
        onto the asyncio queue. The server heartbeats every 15s, so the 60s
        socket timeout only trips on a genuinely dead connection."""

        def put(item: Any) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, item)

        headers = {
            'Authorization': f'Bearer {self._http.api_key()}',
            'Accept': 'text/event-stream',
        }
        if last_seq is not None:
            headers['Last-Event-ID'] = str(last_seq)
        request = urllib.request.Request(
            f'{self._http.base_url()}/api/evaluations/{urllib.parse.quote(id)}/events',
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                connection.response = response
                event_id: Optional[str] = None
                event_type: Optional[str] = None
                data_lines: List[str] = []
                for raw_line in response:
                    line = raw_line.decode('utf-8', errors='replace').rstrip('\r\n')
                    if line == '':
                        if event_id is not None or event_type is not None or data_lines:
                            try:
                                seq = int(event_id) if event_id is not None else -1
                            except ValueError:
                                seq = -1
                            put(('event', EvaluationEvent(
                                seq=seq,
                                type=event_type or 'message',
                                data=_parse_sse_data('\n'.join(data_lines)),
                            )))
                        event_id = None
                        event_type = None
                        data_lines = []
                        continue
                    if line.startswith(':'):
                        continue
                    fieldname, _, value = line.partition(':')
                    if value.startswith(' '):
                        value = value[1:]
                    if fieldname == 'id':
                        event_id = value
                    elif fieldname == 'event':
                        event_type = value
                    elif fieldname == 'data':
                        data_lines.append(value)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            code, message = _parse_error_body(detail, str(exc.reason))
            put(('http_error', exc.code, code, message))
            return
        except Exception as exc:
            put(('error', exc))
            return
        put(('eof', None))

    async def watch_iter(
        self,
        id: str,
        *,
        timeout_s: Optional[float] = None,
        reconnect_delay_s: float = 1.0,
        max_reconnect_delay_s: float = 30.0,
    ) -> AsyncIterator[EvaluationEvent]:
        """Async-iterate the evaluation's server-sent events until terminal.

        Replays from the beginning, resumes with Last-Event-ID on reconnect
        (exponential backoff), and completes on the terminal event
        (``evaluation.completed`` / ``evaluation.cancelled`` /
        ``evaluation.failed``). The iterator sibling of :meth:`watch`.

        Example::

            async for event in evals.watch_iter(evaluation.id):
                print(event.seq, event.type, event.data)
        """
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None

        def remaining() -> Optional[float]:
            if deadline is None:
                return None
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f'watch({id!r}) timed out after {timeout_s}s')
            return left

        last_seq: Optional[int] = None
        delay = reconnect_delay_s
        terminal = False
        final_drain_done = False

        while not terminal:
            remaining()
            loop = asyncio.get_running_loop()
            queue: 'asyncio.Queue' = asyncio.Queue()
            connection = _SseConnection()
            reader = asyncio.ensure_future(
                asyncio.to_thread(self._read_sse_sync, id, last_seq, loop, queue, connection)
            )
            received_event = False
            reconnect = False
            try:
                while True:
                    left = remaining()
                    item = (
                        await asyncio.wait_for(queue.get(), timeout=left)
                        if left is not None
                        else await queue.get()
                    )
                    kind = item[0]
                    if kind == 'event':
                        event: EvaluationEvent = item[1]
                        if event.seq >= 0:
                            last_seq = event.seq
                        received_event = True
                        if event.type in _TERMINAL_EVENT_TYPES:
                            terminal = True
                        yield event
                        if terminal:
                            break
                    elif kind == 'http_error':
                        status, code, message = item[1], item[2], item[3]
                        if status == 429 or status >= 500:
                            reconnect = True
                            break
                        raise EvolveAPIError(status, code, message)
                    elif kind == 'error':
                        reconnect = True
                        break
                    else:  # eof
                        break
            finally:
                connection.close()
                try:
                    await reader
                except Exception:
                    pass

            if terminal:
                return

            if not reconnect:
                # The stream closed cleanly without a terminal event (server
                # drain fallback). Events may still be in flight just after
                # the status turns terminal, so drain once more from last_seq
                # before finishing on status alone.
                current = await self.get(id)
                if current.status in _TERMINAL_EVALUATION_STATUSES:
                    if final_drain_done:
                        return
                    final_drain_done = True
                    continue

            if received_event:
                delay = reconnect_delay_s
            await asyncio.sleep(min(delay, remaining() or delay))
            delay = min(delay * 2, max_reconnect_delay_s)

    async def watch(
        self,
        id: str,
        *,
        on_event: Optional[Callable[[EvaluationEvent], None]] = None,
        timeout_s: Optional[float] = None,
        reconnect_delay_s: float = 1.0,
        max_reconnect_delay_s: float = 30.0,
    ) -> Evaluation:
        """Watch the evaluation's event stream and return the final evaluation.

        Consumes the same server-sent events as :meth:`watch_iter` (replay +
        live, Last-Event-ID resume with exponential backoff), firing
        ``on_event`` for each one, and resolves with the final
        :class:`Evaluation` once the terminal event arrives.
        """
        async for event in self.watch_iter(
            id,
            timeout_s=timeout_s,
            reconnect_delay_s=reconnect_delay_s,
            max_reconnect_delay_s=max_reconnect_delay_s,
        ):
            if on_event is not None:
                on_event(event)
        return await self.get(id)

    # ---------------------------------------------------------------- actions

    async def cancel(self, id: str) -> Evaluation:
        """Request cancellation. Idempotent; a terminal evaluation is a no-op."""
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}/cancel', method='POST', body={}
        )
        return _map_evaluation(raw)

    async def rerun_failed(self, id: str, *, idempotency_key: Optional[str] = None) -> Evaluation:
        """Create a NEW linked evaluation of only the failed task runs."""
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}/rerun-failed',
            method='POST',
            body={},
            headers=headers,
        )
        return _map_evaluation(raw)

    async def regrade(
        self,
        id: str,
        *,
        status: Optional[List[str]] = None,
        task_key: Optional[str] = None,
    ) -> RegradeJob:
        """Regrade a terminal evaluation: re-run the verifier of every REGRADABLE
        run (settled separate-mode runs, which recorded their verifier inputs)
        against those recorded inputs, in fresh separate verifier boxes.

        The agent phase is never re-run and the source runs are never modified.
        ``status`` / ``task_key`` narrow the set of source runs. Returns a new
        regrade job with one result per selected run.
        """
        body: Dict[str, Any] = {}
        if status is not None:
            body['status'] = status
        if task_key is not None:
            body['taskKey'] = task_key
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}/regrade', method='POST', body=body
        )
        return _map_regrade_job(raw)

    async def regrade_task_run(self, id: str, run_id: str) -> RegradeJob:
        """Regrade one settled task run: re-run its verifier against its recorded
        inputs in a fresh separate verifier box.

        Refused (``regrade_source_ineligible``) for shared-mode or
        pre-persistence runs. Returns a regrade job with one result.
        """
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}'
            f'/task-runs/{urllib.parse.quote(run_id)}/regrade',
            method='POST',
            body={},
        )
        return _map_regrade_job(raw)

    async def regrade_job(self, job_id: str) -> RegradeJob:
        """Read a regrade job and its per-run results (with lineage + score deltas)."""
        raw = await self._http.request_json(
            f'/api/regrades/{urllib.parse.quote(job_id)}'
        )
        return _map_regrade_job(raw)

    async def export(
        self,
        id: str,
        *,
        to: Optional[str] = None,
        format: Optional[str] = None,
    ):
        """Download the research archive (gzipped JSON) of a terminal evaluation.

        Returns the archive bytes, or — when ``to`` (a directory) is given —
        streams straight to disk and returns the saved file path.
        ``format='harbor'`` selects the Harbor job-layout bundle instead of
        the canonical archive.
        """
        if format is not None and format != 'harbor':
            raise ValueError(f"Unknown format {format!r}; supported: 'harbor'")
        query = f'?format={urllib.parse.quote(format)}' if format else ''
        path = f'/api/evaluations/{urllib.parse.quote(id)}/export{query}'
        if to is not None:
            return await self._http.download(path, to, f'evaluation-{id}-export.json.gz')
        payload, _headers = await self._http.request_bytes(path)
        return payload

    async def task_run(self, id: str, run_id: str) -> TaskRunDetail:
        """Get one task run's full detail.

        Same shape as a list row plus ``evaluation_id``; unlike list rows,
        ``failure_detail`` is untruncated.
        """
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}'
            f'/task-runs/{urllib.parse.quote(run_id)}'
        )
        return _map_task_run_detail(raw)

    async def task_run_trace(
        self,
        id: str,
        run_id: str,
        *,
        after: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> TaskRunTracePage:
        """Get one seq-paged slice of a task run's trace.

        ``after`` returns events with seq strictly greater than it (omit =
        from the beginning); resume with ``after=page.next_after``.
        """
        params: Dict[str, str] = {}
        if after is not None:
            params['after'] = str(after)
        if limit is not None:
            params['limit'] = str(limit)
        query = urllib.parse.urlencode(params)
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}'
            f'/task-runs/{urllib.parse.quote(run_id)}/trace{("?" + query) if query else ""}'
        )
        return TaskRunTracePage(
            events=[_map_trace_event(item) for item in raw.get('events', [])],
            next_after=raw.get('nextAfter'),
        )

    async def task_run_trace_events(
        self,
        id: str,
        run_id: str,
        *,
        after: Optional[int] = None,
        limit: Optional[int] = None,
    ):
        """Iterate a task run's trace events, fetching pages under the hood.

        Drains the currently available trace, then stops: an empty page, or a
        short page when the caller pinned an explicit page size. Resume later
        by passing the last seen seq as ``after``.
        """
        position = after
        while True:
            page = await self.task_run_trace(id, run_id, after=position, limit=limit)
            for event in page.events:
                yield event
            if not page.events:
                return
            if limit is not None and len(page.events) < limit:
                return
            if page.next_after is None:
                return
            position = page.next_after

    async def compare(self, ids: List[str]) -> EvaluationComparison:
        """Side-by-side comparison of 2-5 owned evaluations.

        Per-evaluation aggregates plus a per-task matrix with disagreement
        rows first. Means cover SCORED runs only; coverage is always reported.
        """
        query = ','.join(urllib.parse.quote(item) for item in ids)
        raw = await self._http.request_json(f'/api/evaluations/compare?ids={query}')
        return EvaluationComparison(
            evaluations=[
                _map_comparison_aggregate(item) for item in raw.get('evaluations', [])
            ],
            task_matrix=[
                _map_comparison_task_row(item) for item in raw.get('taskMatrix', [])
            ],
        )


def _parse_benchmark_ref(ref: str) -> 'tuple[str, Optional[str]]':
    at = ref.find('@')
    if at == -1:
        return ref.strip(), None
    name = ref[:at].strip()
    version = ref[at + 1:].strip()
    if not name or not version:
        raise ValueError(f'Invalid benchmark ref "{ref}": expected "name" or "name@version"')
    return name, version
