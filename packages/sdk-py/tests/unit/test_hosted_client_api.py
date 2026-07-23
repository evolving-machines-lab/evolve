"""
Unit tests for the standalone hosted-evals clients (benchmarks/evaluations).

Coverage:
- benchmarks().list()/get() — catalog + detail mapping, name@version refs
- benchmarks().get_active() — runnable shape (non-optional version/tasks) + NoActiveVersionError
- benchmarks().import_benchmark()/get_import()/watch_import() — git import flow
- evaluations().run() — six(+1)-input body, Idempotency-Key header
- evaluations().get()/list()/task_runs() — mapping + cursor params
- evaluations().list()/task_runs() — await one page + async-for auto-pagination across cursors
- evaluations().task_run()/task_run_trace()/compare() — detail, trace paging, comparison
- evaluations().cancel()/rerun_failed() — POST semantics
- evaluations().export() — bytes, file, and format='harbor' modes
- evaluations().watch()/watch_iter() — poll get() until terminal (documented py difference)
- Reserved import sources (archive/Harbor Hub) raise NotImplementedError offline
- Internal fields (agent system ids/digests) never leak

Mocks urllib at the module boundary; no real network calls.
"""

import gzip
import json
import urllib.parse as urllib_parse
from unittest.mock import patch

import pytest

from evolve import (
    AgentSystem,
    HostedClientConfig,
    NoActiveVersionError,
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
    async def test_get_active_resolves_runnable_shape(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/deep-swe', {
                'name': 'deep-swe',
                'displayTitle': 'DeepSWE',
                'description': 'SWE tasks',
                'activeVersion': '1.1',
                'versions': [
                    {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                    {'version': '1.0', 'state': 'ARCHIVED', 'createdAt': '2026-07-01', 'taskCount': 100},
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
            active = await benchmarks_factory(CONFIG).get_active('deep-swe')

        # Bare name — resolves the active version's task list (no ?version=)
        assert 'version=' not in fake.requests[0].full_url
        assert active.version == '1.1'                 # non-optional
        assert active.active_version.state == 'READY'
        assert len(active.tasks) == 1                  # non-optional
        assert active.tasks[0].task_key == 'abs-module-cache-flags'
        assert len(active.versions) == 2
        assert active.tasks_version == '1.1'

    @pytest.mark.asyncio
    async def test_get_active_raises_when_no_active_version(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/draft-bench', {
                'name': 'draft-bench',
                'displayTitle': None,
                'description': None,
                'activeVersion': None,
                'versions': [{'version': '0.1', 'state': 'DRAFT', 'createdAt': '2026-07-21', 'taskCount': 0}],
                'tasksVersion': None,
                'tasks': [],
                'createdAt': '2026-07-21',
                'updatedAt': '2026-07-21',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(NoActiveVersionError, match='no active version') as exc_info:
                await benchmarks_factory(CONFIG).get_active('draft-bench')
        assert exc_info.value.benchmark == 'draft-bench'

    @pytest.mark.asyncio
    async def test_import_benchmark_posts_git_source(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/import', {'importId': 'imp-1', 'state': 'IMPORTING'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).import_benchmark(
                {'git_url': 'https://github.com/org/bench.git', 'ref': 'v1.2.0'},
                benchmark_name='my-benchmark',
                version='1.2',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        body = json.loads(request.data.decode('utf-8'))
        assert body == {
            'source': {'type': 'git', 'url': 'https://github.com/org/bench.git', 'ref': 'v1.2.0'},
            'benchmarkName': 'my-benchmark',
            'version': '1.2',
        }
        assert job.id == 'imp-1'
        assert job.state == 'IMPORTING'

    @pytest.mark.asyncio
    async def test_get_import_maps_state(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/import/imp-1', {'state': 'READY', 'error': None, 'taskCount': 113}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).get_import('imp-1')

        assert job.id == 'imp-1'  # falls back to the requested id
        assert job.state == 'READY'
        assert job.task_count == 113
        assert job.error is None

    @pytest.mark.asyncio
    async def test_watch_import_polls_until_terminal(self):
        responses = iter([
            {'state': 'IMPORTING'},
            {'state': 'VALIDATING', 'taskCount': 113},
            {'state': 'READY', 'taskCount': 113},
        ])

        class SequenceUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                return FakeResponse(next(responses))

        fake = SequenceUrlopen([])
        states = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            done = await benchmarks_factory(CONFIG).watch_import(
                'imp-1',
                on_state=lambda job: states.append(job.state),
                poll_interval_s=0.001,
            )

        assert done.state == 'READY'
        assert done.task_count == 113
        assert len(fake.requests) == 3
        assert states == ['IMPORTING', 'VALIDATING', 'READY']

    @pytest.mark.asyncio
    async def test_reserved_import_sources(self):
        client = benchmarks_factory(CONFIG)
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.import_benchmark({'archive_path': '/tmp/b.tar.gz'}, benchmark_name='b')
        with pytest.raises(NotImplementedError, match='reserved'):
            await client.import_benchmark({'harbor_hub_ref': 'hub://b'}, benchmark_name='b')
        with pytest.raises(ValueError, match='git source'):
            await client.import_benchmark({'ref': 'main'}, benchmark_name='b')


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
        # Awaiting the handle fetches exactly one page (no cursor walk).
        assert len(fake.requests) == 1

    @pytest.mark.asyncio
    async def test_list_auto_paginates_when_iterated(self):
        pages = {
            None: {'evaluations': [{**RUN_SUMMARY, 'id': 'eval-2'},
                                   {**RUN_SUMMARY, 'id': 'eval-1'}], 'nextCursor': 'eval-1'},
            'eval-1': {'evaluations': [{**RUN_SUMMARY, 'id': 'eval-0'}], 'nextCursor': None},
        }

        class PagedUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                query = urllib_parse.parse_qs(urllib_parse.urlsplit(request.full_url).query)
                cursor = query.get('cursor', [None])[0]
                return FakeResponse(pages[cursor])

        fake = PagedUrlopen([])
        ids = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for evaluation in evaluations_factory(CONFIG).list():
                ids.append(evaluation.id)

        assert ids == ['eval-2', 'eval-1', 'eval-0']
        cursors = [
            urllib_parse.parse_qs(urllib_parse.urlsplit(r.full_url).query).get('cursor', [None])[0]
            for r in fake.requests
        ]
        assert cursors == [None, 'eval-1']

    @pytest.mark.asyncio
    async def test_task_runs_auto_paginates_when_iterated(self):
        def _run(run_id, run_number):
            return {
                'id': run_id,
                'taskKey': 'abs-module-cache-flags',
                'agentSystem': {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None},
                'runNumber': run_number,
                'status': 'SCORED',
                'score': 1,
                'metrics': None,
                'failurePhase': None,
                'failureDetail': None,
                'phaseTimingsMs': None,
                'modelUsage': None,
                'sessionRef': None,
                'createdAt': '2026-07-22T00:00:00.000Z',
                'updatedAt': '2026-07-22T00:00:00.000Z',
            }

        pages = {
            None: {'taskRuns': [_run('run-1', 1), _run('run-2', 2)], 'totalCount': 3, 'nextCursor': 'run-2'},
            'run-2': {'taskRuns': [_run('run-3', 3)], 'totalCount': 3, 'nextCursor': None},
        }

        class PagedUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                query = urllib_parse.parse_qs(urllib_parse.urlsplit(request.full_url).query)
                cursor = query.get('cursor', [None])[0]
                return FakeResponse(pages[cursor])

        fake = PagedUrlopen([])
        run_ids = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for run in evaluations_factory(CONFIG).task_runs('eval-1'):
                run_ids.append(run.id)

        assert run_ids == ['run-1', 'run-2', 'run-3']
        # Await form still returns a single page with totalCount.
        with patch('evolve.hosted.urllib.request.urlopen', PagedUrlopen([])) as _:
            single = await evaluations_factory(CONFIG).task_runs('eval-1', limit=2)
        assert len(single.task_runs) == 2
        assert single.total_count == 3
        assert single.next_cursor == 'run-2'

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
    async def test_watch_iter_yields_states_until_terminal(self):
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
        states = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for state in evaluations_factory(CONFIG).watch_iter(
                'eval-1', poll_interval_s=0.001
            ):
                states.append(state.status)

        # Yields on every status/count change, including the terminal one, then stops.
        assert states == ['RUNNING', 'RUNNING', 'COMPLETED']
        assert len(fake.requests) == 3

    @pytest.mark.asyncio
    async def test_run_posts_per_task_run_cap(self):
        fake = FakeUrlopen([
            ('/api/evaluations', {**RUN_SUMMARY, 'maxModelSpendUsdPerTaskRun': 2}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                max_model_spend_usd=25,
                max_model_spend_usd_per_task_run=2,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['maxModelSpendUsdPerTaskRun'] == 2
        assert evaluation.max_model_spend_usd_per_task_run == 2

    @pytest.mark.asyncio
    async def test_task_run_detail_mapping(self):
        fake = FakeUrlopen([
            ('/api/evaluations/eval-1/task-runs/run-1', {
                'id': 'run-1',
                'evaluationId': 'eval-1',
                'taskKey': 'abs-module-cache-flags',
                'agentSystem': {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None},
                'runNumber': 1,
                'status': 'SCORED',
                'score': 1,
                'metrics': {'f2p': 1.0},
                'failurePhase': None,
                'failureDetail': None,
                'phaseTimingsMs': {'agentMs': 203000, 'verifyMs': 41000},
                'modelUsage': {'spendUsd': 0.93, 'spendSource': 'key_info'},
                'harnessVersionResolved': '0.29.0',
                'sessionRef': 'sess-9',
                'createdAt': '2026-07-22T00:00:00.000Z',
                'updatedAt': '2026-07-22T00:04:00.000Z',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            run = await evaluations_factory(CONFIG).task_run('eval-1', 'run-1')

        assert '/api/evaluations/eval-1/task-runs/run-1' in fake.requests[0].full_url
        assert run.evaluation_id == 'eval-1'
        assert run.harness_version_resolved == '0.29.0'
        assert run.session_ref == 'sess-9'
        assert run.score == 1

    @pytest.mark.asyncio
    async def test_task_run_trace_paging(self):
        fake = FakeUrlopen([
            ('/trace', {
                'events': [
                    {'seq': 3, 'type': 'agent.message', 'data': {'text': 'hi'}},
                    {'seq': 4, 'type': 'tool.call', 'data': {}},
                ],
                'nextAfter': 4,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await evaluations_factory(CONFIG).task_run_trace(
                'eval-1', 'run-1', after=2, limit=500,
            )

        url = fake.requests[0].full_url
        assert '/api/evaluations/eval-1/task-runs/run-1/trace' in url
        assert 'after=2' in url and 'limit=500' in url
        assert [e.seq for e in page.events] == [3, 4]
        assert page.events[0].type == 'agent.message'
        assert page.next_after == 4

    @pytest.mark.asyncio
    async def test_task_run_trace_events_drains_pages(self):
        pages = {
            None: {'events': [{'seq': 1, 'type': 'a', 'data': {}},
                              {'seq': 2, 'type': 'b', 'data': {}}], 'nextAfter': 2},
            '2': {'events': [{'seq': 3, 'type': 'c', 'data': {}}], 'nextAfter': 3},
            '3': {'events': [], 'nextAfter': 3},
        }

        class PagedUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                url = request.full_url
                query = urllib_parse.parse_qs(urllib_parse.urlsplit(url).query)
                after = query.get('after', [None])[0]
                return FakeResponse(pages[after])

        fake = PagedUrlopen([])
        seqs = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for event in evaluations_factory(CONFIG).task_run_trace_events(
                'eval-1', 'run-1'
            ):
                seqs.append(event.seq)

        # Every event exactly once, in seq order, resuming from nextAfter,
        # and the drain stops on the empty page.
        assert seqs == [1, 2, 3]
        afters = [
            urllib_parse.parse_qs(urllib_parse.urlsplit(r.full_url).query).get('after', [None])[0]
            for r in fake.requests
        ]
        assert afters == [None, '2', '3']

    @pytest.mark.asyncio
    async def test_compare_drops_internal_agent_system_fields(self):
        fake = FakeUrlopen([
            ('/api/evaluations/compare', {
                'evaluations': [
                    {
                        'id': 'eval-1',
                        'benchmark': 'deep-swe@1.1',
                        'status': 'COMPLETED',
                        'meanScore': 0.0,  # zero is a score, never nulled
                        'coverage': {'scored': 5, 'total': 5},
                        'spentUsd': 3.2,
                        'agentSystems': [
                            {
                                'id': 'as-internal-1',
                                'harness': 'codex',
                                'model': 'gpt-5.5',
                                'harnessVersion': None,
                                'systemDigest': 'abcd',
                            },
                        ],
                        'createdAt': '2026-07-22T00:00:00.000Z',
                    },
                    {
                        'id': 'eval-2',
                        'benchmark': 'deep-swe@1.1',
                        'status': 'COMPLETED',
                        'meanScore': None,
                        'coverage': {'scored': 0, 'total': 5},
                        'spentUsd': 1.0,
                        'agentSystems': [],
                        'createdAt': '2026-07-22T01:00:00.000Z',
                    },
                ],
                'taskMatrix': [],
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            comparison = await evaluations_factory(CONFIG).compare(['eval-1', 'eval-2'])

        system = comparison.evaluations[0].agent_systems[0]
        assert (system.harness, system.model, system.harness_version) == ('codex', 'gpt-5.5', None)
        assert not hasattr(system, 'id')
        assert not hasattr(system, 'system_digest')
        assert comparison.evaluations[0].mean_score == 0.0
        assert comparison.evaluations[1].mean_score is None

    @pytest.mark.asyncio
    async def test_compare_maps_aggregates_and_matrix(self):
        fake = FakeUrlopen([
            ('/api/evaluations/compare', {
                'evaluations': [
                    {
                        'id': 'eval-1',
                        'benchmark': 'deep-swe@1.1',
                        'status': 'COMPLETED',
                        'meanScore': 0.62,
                        'coverage': {'scored': 100, 'total': 113},
                        'spentUsd': 21.4,
                        'agentSystems': [{'harness': 'codex', 'model': 'gpt-5.5'}],
                        'createdAt': '2026-07-22T00:00:00.000Z',
                    },
                ],
                'taskMatrix': [
                    {
                        'taskKey': 'abs-module-cache-flags',
                        'disagreement': True,
                        'cells': [
                            {
                                'evaluationId': 'eval-1',
                                'status': 'SCORED',
                                'score': 1,
                                'coverage': {'scored': 1, 'total': 1},
                            },
                            {
                                'evaluationId': 'eval-2',
                                'status': 'MISSING',
                                'score': None,
                                'coverage': {'scored': 0, 'total': 0},
                            },
                        ],
                    },
                ],
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            comparison = await evaluations_factory(CONFIG).compare(['eval-1', 'eval-2'])

        assert 'ids=eval-1,eval-2' in fake.requests[0].full_url
        aggregate = comparison.evaluations[0]
        assert aggregate.mean_score == 0.62
        assert (aggregate.coverage.scored, aggregate.coverage.total) == (100, 113)
        assert aggregate.agent_systems[0].harness == 'codex'
        row = comparison.task_matrix[0]
        assert row.disagreement is True
        assert row.cells[1].status == 'MISSING'
        assert row.cells[1].score is None

    @pytest.mark.asyncio
    async def test_export_harbor_format(self):
        archive = gzip.compress(b'{}')
        fake = FakeUrlopen([('/export', archive)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            payload = await evaluations_factory(CONFIG).export('eval-1', format='harbor')

        assert 'format=harbor' in fake.requests[0].full_url
        assert payload == archive

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
