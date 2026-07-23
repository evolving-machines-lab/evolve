"""Hosted evals clients: standalone benchmarks() and evaluations().

Direct-HTTP clients against the dashboard API (same pattern as
browser_credentials.py — no Node bridge). Mirrors the TypeScript SDK's hosted
module 1-1, with one documented difference: ``watch()`` polls ``get()``
instead of consuming the SSE event stream (the JSON-RPC bridge and a
urllib-based client have no streaming SSE story; the TS SDK is the streaming
surface).

Reserved surface: ``import_benchmark()`` with an ``archive_path`` or
``harbor_hub_ref`` source raises NotImplementedError — git is the supported
import source.
"""

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .config import HostedClientConfig

DEFAULT_BASE_URL = 'https://dashboard.evolvingmachines.ai'

_TERMINAL_EVALUATION_STATUSES = {'COMPLETED', 'CANCELLED', 'FAILED'}

# Terminal import statuses.
_TERMINAL_IMPORT_STATUSES = {'READY', 'FAILED'}

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

_RESERVED_MESSAGE = (
    '{feature} is not implemented yet: this method is reserved in the hosted '
    'evals public surface, but the server endpoint does not exist yet. It will '
    'activate in a future release without a signature change.'
)


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
    version: str
    state: str
    task_count: int
    created_at: Optional[str] = None


@dataclass
class Task:
    """Public task fields only — instructions/environments/tests never leave the server."""
    task_key: str
    agent_timeout_sec: int
    verifier_timeout_sec: int


@dataclass
class Benchmark:
    """A benchmark in the shared catalog.

    list() returns the summary fields; get() additionally populates versions,
    tasks_version, tasks, created_at, and updated_at.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: Optional[BenchmarkVersion]
    versions: Optional[List[BenchmarkVersion]] = None
    tasks_version: Optional[str] = None
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
class Evaluation:
    """An evaluation = tasks x agent systems x runs_per_task."""
    id: str
    status: str
    # "name@version"
    benchmark: str
    runs_per_task: int
    concurrency: int
    max_model_spend_usd: float
    spent_usd: float
    created_at: str
    # Per-task-run model-spend cap, when one was set
    max_model_spend_usd_per_task_run: Optional[float] = None
    #: Sandbox provider this evaluation runs on ("e2b" | "daytona" | "modal").
    sandbox_provider: Optional[str] = None
    counts: Optional[Dict[str, int]] = None
    task_run_counts: Optional[Dict[str, int]] = None
    agent_systems: Optional[List[AgentSystem]] = None
    benchmark_version_state: Optional[str] = None
    error: Optional[str] = None
    updated_at: Optional[str] = None
    source_evaluation_id: Optional[str] = None
    idempotent_replay: bool = False


@dataclass
class ModelUsage:
    """Model usage/spend recorded for a task run.

    ``spend_source`` is "key_info" (measured model spend reported by the
    platform) or "assumed_cap" (spend could not be measured for this run, so
    the per-run cap is reported). Harness-specific keys land in ``extra`` with
    snake_case keys.
    """
    spend_usd: Optional[float] = None
    spend_source: Optional[str] = None
    max_budget_usd: Optional[float] = None
    # Resolved harness version actually used for the run
    resolved_harness_version: Optional[str] = None
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
    session_ref: Optional[str]
    created_at: str
    updated_at: str


@dataclass
class TaskRunDetail(TaskRun):
    """Full detail of one task run — evaluations().task_run(id, run_id).

    Unlike list rows, failure_detail is untruncated here.
    """
    evaluation_id: str = ''
    # Harness version actually resolved and used for the run; None until resolved
    resolved_harness_version: Optional[str] = None


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
    score: Optional[float]
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

    Terminal statuses: "READY" and "FAILED".
    """
    id: str
    # Pipeline status, e.g. "IMPORTING", "BUILDING", "VALIDATING", "READY", "FAILED"
    status: str
    # Catalog benchmark name the import creates or extends (create responses)
    benchmark_name: Optional[str] = None
    # Version label of the imported version (create responses)
    version: Optional[str] = None
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
    total_count: int
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
        task_count=int(data.get('taskCount', 0)),
        created_at=data.get('createdAt'),
    )


def _map_task(data: Dict[str, Any]) -> Task:
    return Task(
        task_key=data['taskKey'],
        agent_timeout_sec=int(data.get('agentTimeoutSec', 0)),
        verifier_timeout_sec=int(data.get('verifierTimeoutSec', 0)),
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
        spent_usd=float(data.get('spentUsd', 0)),
        created_at=data.get('createdAt', ''),
        max_model_spend_usd_per_task_run=data.get('maxModelSpendUsdPerTaskRun'),
        sandbox_provider=data.get('sandboxProvider'),
        counts=_snake_keys(data.get('counts')),
        task_run_counts=data.get('taskRunCounts'),
        agent_systems=(
            [_map_agent_system(item) for item in agent_systems]
            if isinstance(agent_systems, list)
            else None
        ),
        benchmark_version_state=data.get('benchmarkVersionState'),
        error=data.get('error'),
        updated_at=data.get('updatedAt'),
        source_evaluation_id=data.get('sourceEvaluationId'),
        idempotent_replay=bool(data.get('idempotentReplay', False)),
    )


_MODEL_USAGE_WIRE_KEYS = {'spendUsd', 'spendSource', 'maxBudgetUsd', 'resolvedHarnessVersion'}


def _map_model_usage(data: Any) -> Optional[ModelUsage]:
    if not isinstance(data, dict):
        return None
    return ModelUsage(
        spend_usd=data.get('spendUsd'),
        spend_source=data.get('spendSource'),
        max_budget_usd=data.get('maxBudgetUsd'),
        resolved_harness_version=data.get('resolvedHarnessVersion'),
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
        session_ref=data.get('sessionRef'),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
    )


def _map_task_run_detail(data: Dict[str, Any]) -> TaskRunDetail:
    base = _map_task_run(data)
    return TaskRunDetail(
        **base.__dict__,
        evaluation_id=data.get('evaluationId', ''),
        resolved_harness_version=data.get('resolvedHarnessVersion'),
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
        score=data.get('score'),
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


def _map_benchmark_import(data: Dict[str, Any]) -> BenchmarkImport:
    benchmark_import = BenchmarkImport(
        id=data.get('id', ''),
        status=data.get('status', ''),
    )
    if isinstance(data.get('benchmarkName'), str):
        benchmark_import.benchmark_name = data.get('benchmarkName')
    if isinstance(data.get('version'), str):
        benchmark_import.version = data.get('version')
    if 'error' in data:
        benchmark_import.error = _map_import_error(data.get('error'))
    if isinstance(data.get('taskCount'), int):
        benchmark_import.task_count = data.get('taskCount')
    return benchmark_import


# =============================================================================
# HTTP CORE
# =============================================================================

class _HostedHttp:
    def __init__(self, factory: str, config: Optional[HostedClientConfig]):
        self._factory = factory
        self._config = config or HostedClientConfig()

    def _base_url(self) -> str:
        return (
            self._config.base_url
            or os.environ.get('EVOLVE_DASHBOARD_URL')
            or DEFAULT_BASE_URL
        ).rstrip('/')

    def _api_key(self) -> str:
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
            'Authorization': f'Bearer {self._api_key()}',
            'Accept': 'application/json',
        }
        if data is not None:
            request_headers['Content-Type'] = 'application/json'
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            f'{self._base_url()}{path}',
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
            detail = exc.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'Evolve API error ({exc.code}): {detail}') from exc
        if not payload:
            return {}
        return json.loads(payload.decode('utf-8'))


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
        return Benchmark(
            name=raw['name'],
            title=raw.get('title'),
            description=raw.get('description'),
            active_version=_map_benchmark_version(active) if active else None,
            versions=[_map_benchmark_version(item) for item in raw.get('versions', [])],
            tasks_version=raw.get('tasksVersion'),
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
        git_url: Optional[str] = None,
        ref: Optional[str] = None,
        benchmark_name: str,
        version: Optional[str] = None,
        archive_path: Optional[str] = None,
        harbor_hub_ref: Optional[str] = None,
    ) -> BenchmarkImport:
        """Start a benchmark import job.

        Git sources (``git_url=..., ref=...``) are live; the reserved
        ``archive_path``/``harbor_hub_ref`` sources raise NotImplementedError
        (no server endpoint yet).
        """
        if archive_path is not None:
            raise NotImplementedError(_RESERVED_MESSAGE.format(
                feature='benchmarks().import_benchmark() with an archive_path source'))
        if harbor_hub_ref is not None:
            raise NotImplementedError(_RESERVED_MESSAGE.format(
                feature='benchmarks().import_benchmark() with a harbor_hub_ref source'))
        if not git_url or not ref:
            raise ValueError(
                'import_benchmark() requires a git source: '
                'git_url=..., ref=... plus benchmark_name=...'
            )
        body: Dict[str, Any] = {
            'source': {'type': 'git', 'url': git_url, 'ref': ref},
            'benchmarkName': benchmark_name,
        }
        if version is not None:
            body['version'] = version
        raw = await self._http.request_json('/api/benchmarks/import', method='POST', body=body)
        return _map_benchmark_import(raw)

    async def get_import(self, id: str) -> BenchmarkImport:
        """Get an import job's status (error and task_count when available)."""
        raw = await self._http.request_json(
            f'/api/benchmarks/import/{urllib.parse.quote(id)}'
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

        Terminal statuses: "READY" or "FAILED" (``error`` populated).
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
# EVALUATIONS CLIENT
# =============================================================================

class EvaluationsClient:
    """Client for hosted evaluations.

    Created via the standalone ``evaluations()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    ``watch()`` polls ``get()`` until the evaluation reaches a terminal status
    (the TypeScript SDK additionally streams the SSE event feed).

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
        agent_systems: List[Any],
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
        ``"name@version"``. Supports Idempotency-Key.
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
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List an evaluation's task runs (cursor-paged).

        ``await`` the result for one page (honoring ``limit``/``cursor``), or
        ``async for`` it to walk every task run across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> TaskRunPage:
            params: Dict[str, str] = {}
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
                total_count=int(raw.get('totalCount', 0)),
                next_cursor=raw.get('nextCursor'),
            )

        return _PaginatedList(
            fetch_page, lambda page: page.task_runs, limit=limit, cursor=cursor
        )

    async def watch(
        self,
        id: str,
        *,
        on_change: Optional[Callable[[Evaluation], None]] = None,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
    ) -> Evaluation:
        """Poll ``get()`` until the evaluation reaches a terminal status.

        ``on_change`` fires whenever status or task_run_counts change. The
        TypeScript SDK's watch() streams the SSE event feed instead; this
        client polls (documented difference).
        """
        if poll_interval_s <= 0:
            raise ValueError('poll_interval_s must be positive')
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        last_fingerprint: Optional[str] = None
        while True:
            evaluation = await self.get(id)
            fingerprint = json.dumps(
                [evaluation.status, evaluation.task_run_counts], sort_keys=True
            )
            if fingerprint != last_fingerprint:
                last_fingerprint = fingerprint
                if on_change is not None:
                    on_change(evaluation)
            if evaluation.status in _TERMINAL_EVALUATION_STATUSES:
                return evaluation
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)

    async def watch_iter(
        self,
        id: str,
        *,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
    ):
        """Async-iterate the evaluation's state as it changes, until terminal.

        Yields the :class:`Evaluation` on every change to status or
        task-run counts (including the initial and terminal states), then stops
        once the evaluation is terminal. This is the iterator sibling of
        :meth:`watch` (which polls and returns the final evaluation). Both poll
        ``get()``; the TypeScript SDK's ``watch()`` streams SSE events instead.

        Example::

            async for state in evals.watch_iter(evaluation.id):
                print(state.status, state.task_run_counts)
        """
        if poll_interval_s <= 0:
            raise ValueError('poll_interval_s must be positive')
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        last_fingerprint: Optional[str] = None
        while True:
            evaluation = await self.get(id)
            fingerprint = json.dumps(
                [evaluation.status, evaluation.task_run_counts], sort_keys=True
            )
            if fingerprint != last_fingerprint:
                last_fingerprint = fingerprint
                yield evaluation
            if evaluation.status in _TERMINAL_EVALUATION_STATUSES:
                return
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch_iter({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)

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

    async def export(self, id: str, *, to: Optional[str] = None, format: Optional[str] = None):
        """Download the research archive (gzipped JSON) of a terminal evaluation.

        Returns the archive bytes, or the saved file path when ``to`` (a
        directory) is given. ``format='harbor'`` selects the Harbor job-layout
        bundle instead of the canonical archive.
        """
        query = f'?format={urllib.parse.quote(format)}' if format else ''
        payload, headers = await self._http.request_bytes(
            f'/api/evaluations/{urllib.parse.quote(id)}/export{query}'
        )
        if to is None:
            return payload
        os.makedirs(to, exist_ok=True)
        disposition = headers.get('Content-Disposition', '') or headers.get('content-disposition', '')
        match = re.search(r'filename="([^"]+)"', disposition)
        filename = match.group(1) if match else f'evaluation-{id}-export.json.gz'
        path = os.path.join(to, filename)
        with open(path, 'wb') as f:
            f.write(payload)
        return path

    async def task_run(self, id: str, run_id: str) -> TaskRunDetail:
        """Get one task run's full detail.

        Includes untruncated failure_detail, the resolved harness version
        actually used (``resolved_harness_version``), and ``session_ref``.
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

        Drains the currently available trace, then stops. Resume later by
        passing the last seen seq as ``after``.
        """
        position = after
        while True:
            page = await self.task_run_trace(id, run_id, after=position, limit=limit)
            for event in page.events:
                yield event
            if page.next_after is None or not page.events:
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
