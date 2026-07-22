"""
Unit tests for the standalone hosted-evals clients (benchmarks/evaluations).

Coverage:
- benchmarks().list()/get() — catalog + detail mapping, name@version refs
- evaluations().run() — six-input body, Idempotency-Key header
- evaluations().get()/list()/task_runs() — mapping + cursor params
- evaluations().cancel()/rerun_failed() — POST semantics
- evaluations().export() — bytes and file modes
- evaluations().watch() — polls get() until terminal (documented py difference)
- Reserved surface raises NotImplementedError without touching the network
- Internal fields (agent system ids/digests) never leak

Mocks urllib at the module boundary; no real network calls.
"""

import gzip
import json
from unittest.mock import patch

import pytest

from evolve import (
    AgentSystem,
    HostedClientConfig,
    benchmarks as benchmarks_factory,
    evaluations as evaluations_factory,
)


class FakeResponse:
    def __init__(self, body, headers=None):
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self.headers = headers or {}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeUrlopen:
    """Callable standing in for urllib.request.urlopen, recording requests."""

    def __init__(self, responses):
        # responses: list of (url_substring, body, headers?) matched in order
        self.responses = responses
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        url = request.full_url
        for entry in self.responses:
            pattern, body = entry[0], entry[1]
            headers = entry[2] if len(entry) > 2 else {}
            if pattern in url:
                return FakeResponse(body, headers)
        raise AssertionError(f'Unexpected request URL: {url}')


CONFIG = HostedClientConfig(api_key='test-key', dashboard_url='http://localhost:3000')

RUN_SUMMARY = {
    'id': 'eval-1',
    'status': 'QUEUED',
    'benchmark': 'deep-swe@1.1',
    'runsPerTask': 1,
    'concurrency': 4,
    'maxModelSpendUsd': 25,
    'spentUsd': 0,
    'counts': {'agentSystems': 1, 'tasks': 5, 'taskRuns': 5},
    'createdAt': '2026-07-22T00:00:00.000Z',
}


class TestFactories:
    def test_requires_api_key(self, monkeypatch):
        monkeypatch.delenv('EVOLVE_API_KEY', raising=False)
        client = benchmarks_factory()
        with pytest.raises(ValueError, match='API key'):
            client._http._api_key()

    def test_config_api_key_wins(self):
        client = evaluations_factory(CONFIG)
        assert client._http._api_key() == 'test-key'
        assert client._http._base_url() == 'http://localhost:3000'


class TestBenchmarks:
    @pytest.mark.asyncio
    async def test_list_maps_catalog(self):
        fake = FakeUrlopen([
            ('/api/benchmarks', {
                'benchmarks': [
                    {
                        'name': 'deep-swe',
                        'displayTitle': 'DeepSWE',
                        'description': 'SWE tasks',
                        'activeVersion': {'version': '1.1', 'state': 'READY', 'taskCount': 113},
                    },
                    {'name': 'empty', 'displayTitle': None, 'description': None, 'activeVersion': None},
                ],
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            catalog = await benchmarks_factory(CONFIG).list()

        assert len(catalog) == 2
        assert catalog[0].name == 'deep-swe'
        assert catalog[0].active_version.version == '1.1'
        assert catalog[0].active_version.task_count == 113
        assert catalog[1].active_version is None
        assert fake.requests[0].get_header('Authorization') == 'Bearer test-key'

    @pytest.mark.asyncio
    async def test_get_resolves_ref_and_maps_detail(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/deep-swe', {
                'name': 'deep-swe',
                'displayTitle': 'DeepSWE',
                'description': 'SWE tasks',
                'activeVersion': '1.1',
                'versions': [
                    {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                ],
                'tasksVersion': '1.1',
                'tasks': [
                    {'taskKey': 'abs-module-cache-flags', 'agentTimeoutSec': 5400, 'verifierTimeoutSec': 1800},
                ],
                'createdAt': '2026-07-01',
                'updatedAt': '2026-07-21',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            detail = await benchmarks_factory(CONFIG).get('deep-swe@1.1')

        assert 'version=1.1' in fake.requests[0].full_url
        assert detail.active_version.version == '1.1'
        assert detail.active_version.state == 'READY'
        assert detail.tasks[0].task_key == 'abs-module-cache-flags'
        assert detail.tasks[0].agent_timeout_sec == 5400

    @pytest.mark.asyncio
    async def test_get_version_conflict_raises(self):
        with pytest.raises(ValueError, match='Conflicting versions'):
            await benchmarks_factory(CONFIG).get('deep-swe@1.1', version='1.0')

    @pytest.mark.asyncio
    async def test_reserved_import_trio(self):
        client = benchmarks_factory(CONFIG)
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.import_benchmark({'gitUrl': 'https://x.git', 'ref': 'main'})
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.get_import('imp-1')
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.watch_import('imp-1')


class TestEvaluations:
    @pytest.mark.asyncio
    async def test_run_posts_six_inputs(self):
        fake = FakeUrlopen([('/api/evaluations', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                tasks=['abs-module-cache-flags'],
                runs_per_task=1,
                concurrency=4,
                max_model_spend_usd=25,
                idempotency_key='idem-abc',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        body = json.loads(request.data.decode('utf-8'))
        assert body == {
            'benchmark': 'deep-swe@1.1',
            'agentSystems': [{'harness': 'codex', 'model': 'gpt-5.5'}],
            'maxModelSpendUsd': 25,
            'tasks': ['abs-module-cache-flags'],
            'runsPerTask': 1,
            'concurrency': 4,
        }
        assert request.get_header('Idempotency-key') == 'idem-abc'
        assert evaluation.id == 'eval-1'
        assert evaluation.counts == {'agentSystems': 1, 'tasks': 5, 'taskRuns': 5}
        assert evaluation.idempotent_replay is False

    @pytest.mark.asyncio
    async def test_get_maps_detail_and_drops_internal_fields(self):
        fake = FakeUrlopen([
            ('/api/evaluations/eval-1', {
                **RUN_SUMMARY,
                'status': 'RUNNING',
                'benchmarkVersionState': 'READY',
                'agentSystems': [
                    {
                        'id': 'as-internal',
                        'harness': 'codex',
                        'model': 'gpt-5.5',
                        'harnessVersion': None,
                        'systemDigest': 'abcd',
                    },
                ],
                'taskRunCounts': {'SCORED': 3, 'RUNNING': 2},
                'taskRunTotal': 5,
                'error': None,
                'updatedAt': '2026-07-22T00:05:00.000Z',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).get('eval-1')

        assert evaluation.status == 'RUNNING'
        assert evaluation.task_run_counts == {'SCORED': 3, 'RUNNING': 2}
        assert evaluation.task_run_total == 5
        system = evaluation.agent_systems[0]
        assert (system.harness, system.model, system.harness_version) == ('codex', 'gpt-5.5', None)
        assert not hasattr(system, 'id')
        assert not hasattr(system, 'system_digest')

    @pytest.mark.asyncio
    async def test_list_builds_cursor_params(self):
        fake = FakeUrlopen([
            ('/api/evaluations', {
                'evaluations': [{**RUN_SUMMARY, 'taskRunCounts': {'SCORED': 5}}],
                'nextCursor': 'eval-0',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await evaluations_factory(CONFIG).list(limit=100, cursor='eval-5')

        url = fake.requests[0].full_url
        assert 'limit=100' in url and 'cursor=eval-5' in url
        assert page.next_cursor == 'eval-0'
        assert page.evaluations[0].task_run_counts == {'SCORED': 5}

    @pytest.mark.asyncio
    async def test_task_runs_mapping(self):
        fake = FakeUrlopen([
            ('/api/evaluations/eval-1/task-runs', {
                'taskRuns': [
                    {
                        'id': 'run-1',
                        'taskKey': 'abs-module-cache-flags',
                        'agentSystem': {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None},
                        'runNumber': 1,
                        'status': 'SCORED',
                        'score': 1,
                        'metrics': {'f2p': 1.0},
                        'failurePhase': None,
                        'failureDetail': None,
                        'phaseTimingsMs': {'agentMs': 203000},
                        'modelUsage': {'spendUsd': 0.93, 'spendSource': 'key_info'},
                        'sessionRef': 'sess-9',
                        'createdAt': '2026-07-22T00:00:00.000Z',
                        'updatedAt': '2026-07-22T00:04:00.000Z',
                    },
                ],
                'totalCount': 5,
                'nextCursor': None,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await evaluations_factory(CONFIG).task_runs('eval-1', limit=1)

        assert 'limit=1' in fake.requests[0].full_url
        assert page.total_count == 5
        run = page.task_runs[0]
        assert run.score == 1
        assert run.metrics == {'f2p': 1.0}
        assert run.model_usage['spendUsd'] == 0.93
        assert run.session_ref == 'sess-9'

    @pytest.mark.asyncio
    async def test_cancel_and_rerun_failed(self):
        fake = FakeUrlopen([
            ('/cancel', {**RUN_SUMMARY, 'status': 'CANCELLING'}),
            ('/rerun-failed', {**RUN_SUMMARY, 'id': 'eval-2', 'sourceEvaluationId': 'eval-1'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = evaluations_factory(CONFIG)
            cancelled = await client.cancel('eval-1')
            rerun = await client.rerun_failed('eval-1', idempotency_key='idem-rr')

        assert cancelled.status == 'CANCELLING'
        assert fake.requests[0].get_method() == 'POST'
        assert rerun.id == 'eval-2'
        assert rerun.source_evaluation_id == 'eval-1'
        assert fake.requests[1].get_header('Idempotency-key') == 'idem-rr'

    @pytest.mark.asyncio
    async def test_export_bytes_and_file(self, tmp_path):
        archive = gzip.compress(json.dumps({'evaluation': {'id': 'eval-1'}}).encode('utf-8'))
        fake = FakeUrlopen([
            ('/export', archive, {'Content-Disposition': 'attachment; filename="evaluation-eval-1-export.json.gz"'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = evaluations_factory(CONFIG)
            payload = await client.export('eval-1')
            path = await client.export('eval-1', to=str(tmp_path))

        assert payload == archive
        assert path.endswith('evaluation-eval-1-export.json.gz')
        with open(path, 'rb') as f:
            assert f.read() == archive

    @pytest.mark.asyncio
    async def test_watch_polls_until_terminal(self):
        responses = iter([
            {**RUN_SUMMARY, 'status': 'RUNNING', 'taskRunCounts': {'RUNNING': 5}},
            {**RUN_SUMMARY, 'status': 'RUNNING', 'taskRunCounts': {'SCORED': 3, 'RUNNING': 2}},
            {**RUN_SUMMARY, 'status': 'COMPLETED', 'taskRunCounts': {'SCORED': 5}},
        ])

        class SequenceUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                return FakeResponse(next(responses))

        fake = SequenceUrlopen([])
        changes = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            final = await evaluations_factory(CONFIG).watch(
                'eval-1',
                on_change=lambda e: changes.append(e.status),
                poll_interval_s=0.001,
            )

        assert final.status == 'COMPLETED'
        assert len(fake.requests) == 3
        assert changes == ['RUNNING', 'RUNNING', 'COMPLETED']

    @pytest.mark.asyncio
    async def test_watch_timeout(self):
        class AlwaysRunning(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                return FakeResponse({**RUN_SUMMARY, 'status': 'RUNNING'})

        fake = AlwaysRunning([])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(TimeoutError):
                await evaluations_factory(CONFIG).watch(
                    'eval-1', poll_interval_s=0.001, timeout_s=0.01
                )

    @pytest.mark.asyncio
    async def test_reserved_compare_and_task_run(self):
        client = evaluations_factory(CONFIG)
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.compare(['eval-1', 'eval-2'])
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.task_run('run-1')

    @pytest.mark.asyncio
    async def test_http_error_includes_status_and_detail(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409,
                'Conflict', {},
                io.BytesIO(b'{"error":"Evaluation is RUNNING; export requires a terminal evaluation"}'),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(RuntimeError, match=r'409.*terminal'):
                await evaluations_factory(CONFIG).export('eval-1')
