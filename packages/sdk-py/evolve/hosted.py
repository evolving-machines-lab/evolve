"""Hosted evals clients: standalone benchmarks() and evaluations().

Direct-HTTP clients against the dashboard API (same pattern as
browser_credentials.py — no Node bridge). Mirrors the TypeScript SDK's hosted
module 1-1, with one documented difference: ``watch()`` polls ``get()``
instead of consuming the SSE event stream (the JSON-RPC bridge and a
urllib-based client have no streaming SSE story; the TS SDK is the streaming
surface).

Reserved surface (compare, task_run detail, the import trio) raises
NotImplementedError — those server endpoints do not exist yet.
"""

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from .config import HostedClientConfig

DEFAULT_DASHBOARD_URL = 'https://dashboard.evolvingmachines.ai'

_TERMINAL_EVALUATION_STATUSES = {'COMPLETED', 'CANCELLED', 'FAILED'}

_RESERVED_MESSAGE = (
    '{feature} is not implemented yet: this method is reserved in the hosted '
    'evals public surface, but the server endpoint does not exist yet. It will '
    'activate in a future release without a signature change.'
)


# =============================================================================
# PUBLIC TYPES (mirror the plan's list; nothing internal leaks)
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
    display_title: Optional[str]
    description: Optional[str]
    active_version: Optional[BenchmarkVersion]
    versions: Optional[List[BenchmarkVersion]] = None
    tasks_version: Optional[str] = None
    tasks: Optional[List[Task]] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class AgentSystem:
    harness: str
    model: str
    harness_version: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'harness': self.harness, 'model': self.model}
        if self.harness_version is not None:
            result['harnessVersion'] = self.harness_version
        return result


@dataclass
class Evaluation:
    """An evaluation = tasks x agent systems x runs_per_task."""
    id: str
    status: str
    benchmark: str
    runs_per_task: int
    concurrency: int
    max_model_spend_usd: float
    spent_usd: float
    created_at: str
    counts: Optional[Dict[str, int]] = None
    task_run_counts: Optional[Dict[str, int]] = None
    task_run_total: Optional[int] = None
    agent_systems: Optional[List[AgentSystem]] = None
    benchmark_version_state: Optional[str] = None
    error: Optional[str] = None
    updated_at: Optional[str] = None
    source_evaluation_id: Optional[str] = None
    idempotent_replay: bool = False


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
    phase_timings_ms: Optional[Dict[str, float]]
    model_usage: Optional[Dict[str, Any]]
    session_ref: Optional[str]
    created_at: str
    updated_at: str


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
    # Only the public triple — internal ids/digests never leak.
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
        counts=data.get('counts'),
        task_run_counts=data.get('taskRunCounts'),
        task_run_total=data.get('taskRunTotal'),
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
        phase_timings_ms=data.get('phaseTimingsMs'),
        model_usage=data.get('modelUsage'),
        session_ref=data.get('sessionRef'),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
    )


# =============================================================================
# HTTP CORE
# =============================================================================

class _HostedHttp:
    def __init__(self, factory: str, config: Optional[HostedClientConfig]):
        self._factory = factory
        self._config = config or HostedClientConfig()

    def _base_url(self) -> str:
        return (
            self._config.dashboard_url
            or os.environ.get('EVOLVE_DASHBOARD_URL')
            or DEFAULT_DASHBOARD_URL
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
            raise RuntimeError(f'Dashboard API error ({exc.code}): {detail}') from exc
        if not payload:
            return {}
        return json.loads(payload.decode('utf-8'))


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
                display_title=raw.get('displayTitle'),
                description=raw.get('description'),
                active_version=_map_benchmark_version(active) if active else None,
            ))
        return result

    async def get(self, ref: str, *, version: Optional[str] = None) -> Benchmark:
        """Get one benchmark: all versions + the selected version's task list.

        ``ref`` is ``"name"`` (active version's tasks) or ``"name@version"``.
        """
        name, ref_version = _parse_benchmark_ref(ref)
        if version is not None and ref_version is not None and version != ref_version:
            raise ValueError(
                f'Conflicting versions: ref "{ref}" says "{ref_version}" but '
                f'version is "{version}"'
            )
        selected = version if version is not None else ref_version
        query = f'?version={urllib.parse.quote(selected)}' if selected is not None else ''
        raw = await self._http.request_json(
            f'/api/benchmarks/{urllib.parse.quote(name)}{query}'
        )
        versions = [_map_benchmark_version(item) for item in raw.get('versions', [])]
        active_name = raw.get('activeVersion')
        active = next((v for v in versions if v.version == active_name), None)
        return Benchmark(
            name=raw['name'],
            display_title=raw.get('displayTitle'),
            description=raw.get('description'),
            active_version=active,
            versions=versions,
            tasks_version=raw.get('tasksVersion'),
            tasks=[_map_task(item) for item in raw.get('tasks', [])],
            created_at=raw.get('createdAt'),
            updated_at=raw.get('updatedAt'),
        )

    # -- RESERVED surface (no server endpoints yet) ---------------------------

    async def import_benchmark(self, source: Dict[str, Any]) -> Any:
        """RESERVED — raises NotImplementedError (no server endpoint yet)."""
        raise NotImplementedError(_RESERVED_MESSAGE.format(feature='benchmarks().import_benchmark()'))

    async def get_import(self, id: str) -> Any:
        """RESERVED — raises NotImplementedError (no server endpoint yet)."""
        raise NotImplementedError(_RESERVED_MESSAGE.format(feature='benchmarks().get_import()'))

    async def watch_import(self, id: str) -> Any:
        """RESERVED — raises NotImplementedError (no server endpoint yet)."""
        raise NotImplementedError(_RESERVED_MESSAGE.format(feature='benchmarks().watch_import()'))


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
        agent_systems: List[Any],
        max_model_spend_usd: float,
        tasks: Optional[List[str]] = None,
        runs_per_task: Optional[int] = None,
        concurrency: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Evaluation:
        """Create an evaluation (the six-input contract). Supports Idempotency-Key."""
        body: Dict[str, Any] = {
            'benchmark': benchmark,
            'agentSystems': [
                system.to_dict() if isinstance(system, AgentSystem) else dict(system)
                for system in agent_systems
            ],
            'maxModelSpendUsd': max_model_spend_usd,
        }
        if tasks is not None:
            body['tasks'] = tasks
        if runs_per_task is not None:
            body['runsPerTask'] = runs_per_task
        if concurrency is not None:
            body['concurrency'] = concurrency
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json('/api/evaluations', method='POST', body=body, headers=headers)
        return _map_evaluation(raw)

    async def get(self, id: str) -> Evaluation:
        """Get one evaluation with agent systems + task-run status counts."""
        raw = await self._http.request_json(f'/api/evaluations/{urllib.parse.quote(id)}')
        return _map_evaluation(raw)

    async def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> EvaluationPage:
        """List the caller's evaluations, newest first (cursor-paged)."""
        params: Dict[str, str] = {}
        if limit is not None:
            params['limit'] = str(limit)
        if cursor is not None:
            params['cursor'] = cursor
        query = urllib.parse.urlencode(params)
        raw = await self._http.request_json(f'/api/evaluations{("?" + query) if query else ""}')
        return EvaluationPage(
            evaluations=[_map_evaluation(item) for item in raw.get('evaluations', [])],
            next_cursor=raw.get('nextCursor'),
        )

    async def task_runs(
        self,
        id: str,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> TaskRunPage:
        """List an evaluation's task runs (cursor-paged)."""
        params: Dict[str, str] = {}
        if limit is not None:
            params['limit'] = str(limit)
        if cursor is not None:
            params['cursor'] = cursor
        query = urllib.parse.urlencode(params)
        raw = await self._http.request_json(
            f'/api/evaluations/{urllib.parse.quote(id)}/task-runs{("?" + query) if query else ""}'
        )
        return TaskRunPage(
            task_runs=[_map_task_run(item) for item in raw.get('taskRuns', [])],
            total_count=int(raw.get('totalCount', 0)),
            next_cursor=raw.get('nextCursor'),
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

    async def export(self, id: str, *, to: Optional[str] = None):
        """Download the research archive (gzipped JSON) of a terminal evaluation.

        Returns the archive bytes, or the saved file path when ``to`` (a
        directory) is given.
        """
        payload, headers = await self._http.request_bytes(
            f'/api/evaluations/{urllib.parse.quote(id)}/export'
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

    # -- RESERVED surface (no server endpoints yet) ---------------------------

    async def task_run(self, run_id: str) -> Any:
        """RESERVED — raises NotImplementedError (no server endpoint yet)."""
        raise NotImplementedError(_RESERVED_MESSAGE.format(feature='evaluations().task_run()'))

    async def compare(self, ids: List[str]) -> Any:
        """RESERVED — raises NotImplementedError (no server endpoint yet)."""
        raise NotImplementedError(_RESERVED_MESSAGE.format(feature='evaluations().compare()'))


def _parse_benchmark_ref(ref: str) -> 'tuple[str, Optional[str]]':
    at = ref.find('@')
    if at == -1:
        return ref.strip(), None
    name = ref[:at].strip()
    version = ref[at + 1:].strip()
    if not name or not version:
        raise ValueError(f'Invalid benchmark ref "{ref}": expected "name" or "name@version"')
    return name, version
