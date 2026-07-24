"""
Unit tests for the standalone hosted-evals clients
(benchmarks/custom_harnesses/evaluations).

Coverage:
- benchmarks().list()/get() — catalog + detail mapping (selected_version,
  per-task provider verdicts), name@version refs
- custom_harnesses().create()/list()/get()/delete() — the two registration
  lanes (install-script JSON body vs uploaded tarball with metadata on the
  query string), owner-private not-found, name-taken
- benchmarks().get_active() — runnable shape (non-optional version/tasks) + NoActiveVersionError
- benchmarks().import_benchmark()/get_import()/watch_import() — git import flow
  (self-describing jobs, IMPORTED/FAILED terminal statuses)
- evaluations().run() — contract body (field order), Idempotency-Key header
- evaluations().get()/list()/task_runs() — mapping + cursor params + status filter
- evaluations().list()/task_runs() — await one page + async-for auto-pagination across cursors
- evaluations().task_run()/task_run_trace()/compare() — detail, trace paging, comparison
- evaluations().cancel()/rerun_failed() — POST semantics
- evaluations().export() — bytes, streamed-to-file, and format='harbor' modes
- evaluations().watch()/watch_iter() — SSE event stream: replay, Last-Event-ID
  resume on reconnect, terminal-event completion, timeout
- EvolveAPIError — typed {error: {code, message}} mapping
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
    EvaluationCounts,
    EvolveAPIError,
    HostedClientConfig,
    NoActiveVersionError,
    TaskProviderVerdict,
    benchmarks as benchmarks_factory,
    custom_harnesses as custom_harnesses_factory,
    evaluations as evaluations_factory,
)


class FakeResponse:
    def __init__(self, body, headers=None):
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self._offset = 0
        self.headers = headers or {}

    def read(self, size=-1):
        if self._offset >= len(self._body):
            return b''
        if size is None or size < 0:
            chunk = self._body[self._offset:]
        else:
            chunk = self._body[self._offset:self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeSseResponse(FakeResponse):
    """SSE stream: iterable over its lines, like a urllib response."""

    def __iter__(self):
        for line in self._body.split(b'\n'):
            yield line + b'\n'


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


CONFIG = HostedClientConfig(api_key='test-key', base_url='http://localhost:3000')

RUN_SUMMARY = {
    'id': 'eval-1',
    'status': 'QUEUED',
    'benchmark': 'deep-swe@1.1',
    'runsPerTask': 1,
    'concurrency': 4,
    'maxModelSpendUsd': 25,
    'sandboxProvider': 'e2b',
    'spentUsd': 0,
    'counts': {'agentSystems': 1, 'tasks': 5, 'taskRuns': 5},
    'createdAt': '2026-07-22T00:00:00.000Z',
}

ALL_OK_PROVIDERS = {'e2b': {'ok': True}, 'daytona': {'ok': True}, 'modal': {'ok': True}}


def sse_text(events):
    return ''.join(
        f'id: {e["seq"]}\nevent: {e["type"]}\ndata: {json.dumps(e["data"])}\n\n'
        for e in events
    )


class TestFactories:
    def test_requires_api_key(self, monkeypatch):
        monkeypatch.delenv('EVOLVE_API_KEY', raising=False)
        client = benchmarks_factory()
        with pytest.raises(ValueError, match='API key'):
            client._http.api_key()

    def test_config_api_key_wins(self):
        client = evaluations_factory(CONFIG)
        assert client._http.api_key() == 'test-key'
        assert client._http.base_url() == 'http://localhost:3000'


class TestBenchmarks:
    @pytest.mark.asyncio
    async def test_list_maps_catalog(self):
        fake = FakeUrlopen([
            ('/api/benchmarks', {
                'benchmarks': [
                    {
                        'name': 'deep-swe',
                        'title': 'DeepSWE',
                        'description': 'SWE tasks',
                        'activeVersion': {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                    },
                    {'name': 'empty', 'title': None, 'description': None, 'activeVersion': None},
                ],
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            catalog = await benchmarks_factory(CONFIG).list()

        assert len(catalog) == 2
        assert catalog[0].name == 'deep-swe'
        assert catalog[0].title == 'DeepSWE'
        assert catalog[0].active_version.version == '1.1'
        assert catalog[0].active_version.created_at == '2026-07-21'
        assert catalog[0].active_version.task_count == 113
        assert catalog[1].active_version is None
        assert fake.requests[0].get_header('Authorization') == 'Bearer test-key'

    @pytest.mark.asyncio
    async def test_get_resolves_ref_and_maps_detail(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/deep-swe', {
                'name': 'deep-swe',
                'title': 'DeepSWE',
                'description': 'SWE tasks',
                'activeVersion': {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                'versions': [
                    {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                ],
                'selectedVersion': {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                'tasks': [
                    {
                        'taskKey': 'abs-module-cache-flags',
                        'agentTimeoutSec': 5400,
                        'verifierTimeoutSec': 1800,
                        'providers': {
                            'e2b': {'ok': True},
                            'daytona': {'ok': True},
                            'modal': {'ok': False, 'reason': 'multi-container tasks are not supported on modal'},
                        },
                    },
                ],
                'createdAt': '2026-07-01',
                'updatedAt': '2026-07-21',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            detail = await benchmarks_factory(CONFIG).get('deep-swe@1.1')

        assert 'version=1.1' in fake.requests[0].full_url
        # activeVersion arrives as the full version object — no client re-resolve
        assert detail.title == 'DeepSWE'
        assert detail.active_version.version == '1.1'
        assert detail.active_version.state == 'READY'
        assert detail.active_version.task_count == 113
        # selected_version is a full version object — the tasks' provenance
        assert detail.selected_version.version == '1.1'
        assert detail.selected_version.created_at == '2026-07-21'
        task = detail.tasks[0]
        assert task.task_key == 'abs-module-cache-flags'
        assert task.agent_timeout_sec == 5400
        # Per-provider capability verdicts — visible before any money is spent
        assert task.providers['e2b'] == TaskProviderVerdict(ok=True)
        assert task.providers['modal'] == TaskProviderVerdict(
            ok=False, reason='multi-container tasks are not supported on modal'
        )

    @pytest.mark.asyncio
    async def test_get_active_resolves_runnable_shape(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/deep-swe', {
                'name': 'deep-swe',
                'title': 'DeepSWE',
                'description': 'SWE tasks',
                'activeVersion': {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                'versions': [
                    {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                    {'version': '1.0', 'state': 'ARCHIVED', 'createdAt': '2026-07-01', 'taskCount': 100},
                ],
                'selectedVersion': {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                'tasks': [
                    {
                        'taskKey': 'abs-module-cache-flags',
                        'agentTimeoutSec': 5400,
                        'verifierTimeoutSec': 1800,
                        'providers': ALL_OK_PROVIDERS,
                    },
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
        assert active.tasks[0].providers['daytona'].ok is True
        assert len(active.versions) == 2

    @pytest.mark.asyncio
    async def test_get_active_raises_when_no_active_version(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/draft-bench', {
                'name': 'draft-bench',
                'title': None,
                'description': None,
                'activeVersion': None,
                'versions': [{'version': '0.1', 'state': 'DRAFT', 'createdAt': '2026-07-21', 'taskCount': 0}],
                'selectedVersion': None,
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
            ('/api/benchmarks/imports', {
                'id': 'imp-1', 'status': 'IMPORTING', 'benchmarkName': 'my-benchmark', 'version': '1.2',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).import_benchmark(
                git_url='https://github.com/org/bench.git',
                ref='v1.2.0',
                benchmark_name='my-benchmark',
                version='1.2',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        assert '/api/benchmarks/imports' in request.full_url
        body = json.loads(request.data.decode('utf-8'))
        assert body == {
            'source': {'type': 'git', 'url': 'https://github.com/org/bench.git', 'ref': 'v1.2.0'},
            'benchmarkName': 'my-benchmark',
            'version': '1.2',
        }
        assert job.id == 'imp-1'
        assert job.status == 'IMPORTING'
        assert job.benchmark_name == 'my-benchmark'
        assert job.version == '1.2'

    @pytest.mark.asyncio
    async def test_import_benchmark_uploads_a_directory(self, tmp_path):
        import io
        import tarfile

        from evolve.hosted import _tar_gzip_directory

        # A tiny Harbor-layout corpus on disk.
        task_dir = tmp_path / 'tasks' / 'abc'
        task_dir.mkdir(parents=True)
        (task_dir / 'task.toml').write_text('schema_version = "1.1"\n')

        fake = FakeUrlopen([
            ('/api/benchmarks/imports', {
                'id': 'imp-9', 'status': 'IMPORTING', 'benchmarkName': 'my-bench', 'version': '0.1',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).import_benchmark(
                directory=str(tmp_path),
                benchmark_name='my-bench',
                version='0.1',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        # The body IS the tarball, so benchmarkName/version ride the query string.
        assert '/api/benchmarks/imports?' in request.full_url
        assert 'benchmarkName=my-bench' in request.full_url
        assert 'version=0.1' in request.full_url
        assert request.get_header('Content-type') == 'application/gzip'

        data = request.data
        assert data[:2] == b'\x1f\x8b'  # gzip magic
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r') as tar:
            names = tar.getnames()
        assert 'tasks/abc/task.toml' in names

        # Deterministic: the same directory always tars to the same bytes.
        assert _tar_gzip_directory(str(tmp_path)) == _tar_gzip_directory(str(tmp_path))

        assert job.id == 'imp-9'
        assert job.status == 'IMPORTING'
        assert job.benchmark_name == 'my-bench'

    @pytest.mark.asyncio
    async def test_get_import_maps_status(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/imports/imp-1', {
                'id': 'imp-1', 'status': 'IMPORTED', 'benchmarkName': 'my-benchmark',
                'version': '1.2', 'taskCount': 113, 'error': None,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).get_import('imp-1')

        assert job.id == 'imp-1'
        assert job.status == 'IMPORTED'
        # Self-describing: a watcher holding only the id learns what it watches
        assert job.benchmark_name == 'my-benchmark'
        assert job.version == '1.2'
        assert job.task_count == 113
        assert job.error is None

    @pytest.mark.asyncio
    async def test_get_import_maps_structured_error_to_snake_case(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/imports/imp-2', {
                'id': 'imp-2',
                'status': 'FAILED',
                'benchmarkName': 'my-benchmark',
                'version': '1.2',
                'error': {
                    'message': '1/2 task(s) failed to parse',
                    'failures': [{'taskKey': 'bad-task', 'error': 'boom'}],
                },
                'taskCount': 0,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).get_import('imp-2')

        assert job.status == 'FAILED'
        assert job.error is not None
        assert job.error.message == '1/2 task(s) failed to parse'
        # Wire camelCase (taskKey) never reaches Python users
        assert job.error.failures[0].task_key == 'bad-task'
        assert job.error.failures[0].error == 'boom'

    @pytest.mark.asyncio
    async def test_watch_import_polls_until_terminal(self):
        job = {'id': 'imp-1', 'benchmarkName': 'my-benchmark', 'version': '1.2'}
        responses = iter([
            {**job, 'status': 'IMPORTING'},
            {**job, 'status': 'IMPORTING', 'taskCount': 0},
            {**job, 'status': 'IMPORTED', 'taskCount': 113},
        ])

        class SequenceUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                return FakeResponse(next(responses))

        fake = SequenceUrlopen([])
        statuses = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            done = await benchmarks_factory(CONFIG).watch_import(
                'imp-1',
                on_status=lambda j: statuses.append(j.status),
                poll_interval_s=0.001,
            )

        assert done.status == 'IMPORTED'
        assert done.task_count == 113
        assert len(fake.requests) == 3
        assert statuses == ['IMPORTING', 'IMPORTED']

    @pytest.mark.asyncio
    async def test_import_requires_complete_git_source(self):
        client = benchmarks_factory(CONFIG)
        with pytest.raises(ValueError, match='git source'):
            await client.import_benchmark(git_url='', ref='main', benchmark_name='b', version='1.0')
        with pytest.raises(TypeError):
            # version is required — the import surface has no server-assigned labels
            await client.import_benchmark(git_url='g', ref='main', benchmark_name='b')


CUSTOM_HARNESS = {
    'name': 'acme-cli',
    'source': 'install_script',
    'runCommand': 'acme-cli --headless',
    'env': {'ACME_PROFILE': 'bench'},
    'createdAt': '2026-07-24T00:00:00Z',
    'updatedAt': '2026-07-24T00:00:00Z',
}


class TestCustomHarnesses:
    @pytest.mark.asyncio
    async def test_create_posts_the_install_script_body(self):
        fake = FakeUrlopen([('/api/custom-harnesses', CUSTOM_HARNESS)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            harness = await custom_harnesses_factory(CONFIG).create(
                name='acme-cli',
                install_script='curl -fsSL https://acme.dev/install.sh | sh',
                run_command='acme-cli --headless',
                env={'ACME_PROFILE': 'bench'},
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        assert request.full_url.endswith('/api/custom-harnesses')
        assert request.get_header('Content-type') == 'application/json'
        assert json.loads(request.data.decode('utf-8')) == {
            'name': 'acme-cli',
            'installScript': 'curl -fsSL https://acme.dev/install.sh | sh',
            'runCommand': 'acme-cli --headless',
            'env': {'ACME_PROFILE': 'bench'},
        }

        assert harness.name == 'acme-cli'
        assert harness.source == 'install_script'
        assert harness.run_command == 'acme-cli --headless'
        assert harness.env == {'ACME_PROFILE': 'bench'}
        assert harness.created_at == '2026-07-24T00:00:00Z'

    @pytest.mark.asyncio
    async def test_create_uploads_a_directory_with_metadata_on_the_query(self, tmp_path):
        import io
        import tarfile

        bin_dir = tmp_path / 'bin'
        bin_dir.mkdir(parents=True)
        (bin_dir / 'acme-cli').write_text('#!/bin/sh\nexec acme "$@"\n')

        fake = FakeUrlopen([
            ('/api/custom-harnesses', {**CUSTOM_HARNESS, 'source': 'tarball'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            harness = await custom_harnesses_factory(CONFIG).create(
                name='acme-cli',
                directory=str(tmp_path),
                run_command='acme-cli --headless',
                env={'ACME_PROFILE': 'bench', 'ACME_REGION': 'us'},
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        # The body IS the tarball, so the metadata rides the query string —
        # repeated env=KEY=VALUE pairs, like the benchmark archive-import lane.
        assert '/api/custom-harnesses?' in request.full_url
        query = urllib_parse.parse_qs(urllib_parse.urlparse(request.full_url).query)
        assert query['name'] == ['acme-cli']
        assert query['runCommand'] == ['acme-cli --headless']
        assert query['env'] == ['ACME_PROFILE=bench', 'ACME_REGION=us']
        assert request.get_header('Content-type') == 'application/gzip'

        data = request.data
        assert data[:2] == b'\x1f\x8b'  # gzip magic
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r') as tar:
            names = tar.getnames()
        assert 'bin/acme-cli' in names

        assert harness.source == 'tarball'

    @pytest.mark.asyncio
    async def test_create_requires_exactly_one_source(self):
        client = custom_harnesses_factory(CONFIG)
        with pytest.raises(ValueError, match='not both'):
            await client.create(
                name='acme-cli',
                install_script='true',
                directory='/tmp/acme',
                run_command='acme-cli',
            )
        with pytest.raises(ValueError, match='install_script'):
            await client.create(name='acme-cli', run_command='acme-cli')

    @pytest.mark.asyncio
    async def test_list_get_and_delete(self):
        fake = FakeUrlopen([
            ('/api/custom-harnesses/acme-cli', b''),
            ('/api/custom-harnesses', {'customHarnesses': [CUSTOM_HARNESS]}),
        ])
        # get() must resolve the detail route, so answer it before the list route.
        get_fake = FakeUrlopen([('/api/custom-harnesses/acme-cli', CUSTOM_HARNESS)])

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            listed = await custom_harnesses_factory(CONFIG).list()
        assert [harness.name for harness in listed] == ['acme-cli']
        assert listed[0].source == 'install_script'

        with patch('evolve.hosted.urllib.request.urlopen', get_fake):
            one = await custom_harnesses_factory(CONFIG).get('acme-cli')
        assert get_fake.requests[0].full_url.endswith('/api/custom-harnesses/acme-cli')
        assert one.run_command == 'acme-cli --headless'

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            deleted = await custom_harnesses_factory(CONFIG).delete('acme-cli')
        assert fake.requests[-1].get_method() == 'DELETE'
        assert deleted is None  # 204 No Content

    @pytest.mark.asyncio
    async def test_not_found_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'custom_harness_not_found',
                    'message': 'No custom harness named "someone-elses".',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await custom_harnesses_factory(CONFIG).get('someone-elses')
        assert exc.value.status == 404
        # Another owner's name reads as not-found — existence is never leaked.
        assert exc.value.code == 'custom_harness_not_found'

    @pytest.mark.asyncio
    async def test_name_taken_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'custom_harness_name_taken',
                    'message': 'You already registered a custom harness named "acme-cli".',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await custom_harnesses_factory(CONFIG).create(
                    name='acme-cli', install_script='true', run_command='acme-cli'
                )
        assert exc.value.status == 409
        assert exc.value.code == 'custom_harness_name_taken'


class TestEvaluations:
    @pytest.mark.asyncio
    async def test_run_posts_contract_body_in_field_order(self):
        fake = FakeUrlopen([('/api/evaluations', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                tasks=['abs-module-cache-flags'],
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
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
            'tasks': ['abs-module-cache-flags'],
            'agentSystems': [{'harness': 'codex', 'model': 'gpt-5.5'}],
            'runsPerTask': 1,
            'concurrency': 4,
            'maxModelSpendUsd': 25,
        }
        # Wire body is emitted in the contract's field order
        assert list(body) == [
            'benchmark', 'tasks', 'agentSystems', 'runsPerTask', 'concurrency', 'maxModelSpendUsd',
        ]
        assert request.get_header('Idempotency-key') == 'idem-abc'
        assert evaluation.id == 'eval-1'
        assert evaluation.sandbox_provider == 'e2b'
        assert evaluation.counts == EvaluationCounts(agent_systems=1, tasks=5, task_runs=5)
        assert evaluation.idempotent_replay is False

    @pytest.mark.asyncio
    async def test_run_accepts_snake_case_agent_system_dicts(self):
        fake = FakeUrlopen([('/api/evaluations', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[{'harness': 'codex', 'model': 'gpt-5.5', 'harness_version': '0.29.0'}],
                max_model_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['agentSystems'] == [
            {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': '0.29.0'},
        ]
        # camelCase keys are not part of the Python surface
        with pytest.raises(TypeError):
            await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[{'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': '0.29.0'}],
                max_model_spend_usd=25,
            )

    @pytest.mark.asyncio
    async def test_unknown_harness_version_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'harness_version_not_found',
                    'message': 'Harness "codex" has no version "9.9.9".',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await evaluations_factory(CONFIG).run(
                    benchmark='deep-swe',
                    agent_systems=[
                        AgentSystem(harness='codex', model='gpt-5.5', harness_version='9.9.9'),
                    ],
                    max_model_spend_usd=25,
                )
        assert exc.value.status == 404
        assert exc.value.code == 'harness_version_not_found'

    @pytest.mark.asyncio
    async def test_insufficient_credits_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 402, 'Payment Required', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'insufficient_credits',
                    'message': 'Your account is out of credits; add credits before starting an evaluation',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await evaluations_factory(CONFIG).run(
                    benchmark='deep-swe',
                    agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                )
        assert exc.value.status == 402
        assert exc.value.code == 'insufficient_credits'

    @pytest.mark.asyncio
    async def test_non_exact_harness_version_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 400, 'Bad Request', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'invalid_input',
                    'message': 'harnessVersion "^0.29.0" must be an exact version.',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await evaluations_factory(CONFIG).run(
                    benchmark='deep-swe',
                    # A range cannot hold a comparison still, so it is refused.
                    agent_systems=[
                        AgentSystem(harness='codex', model='gpt-5.5', harness_version='^0.29.0'),
                    ],
                    max_model_spend_usd=25,
                )
        assert exc.value.status == 400
        # A non-exact pin is invalid_input, not harness_version_not_found
        assert exc.value.code == 'invalid_input'
        assert 'exact version' in str(exc.value)

    @pytest.mark.asyncio
    async def test_unpinned_agent_system_sends_no_harness_version(self):
        fake = FakeUrlopen([('/api/evaluations', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await evaluations_factory(CONFIG).run(
                benchmark='deep-swe',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                max_model_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # Omitted = resolve latest at dispatch; the key is absent, never null.
        assert body['agentSystems'] == [{'harness': 'codex', 'model': 'gpt-5.5'}]

    @pytest.mark.asyncio
    async def test_get_maps_detail_and_drops_internal_fields(self):
        fake = FakeUrlopen([
            ('/api/evaluations/eval-1', {
                **RUN_SUMMARY,
                'status': 'RUNNING',
                'agentSystems': [
                    {
                        'harness': 'codex',
                        'model': 'gpt-5.5',
                        'harnessVersion': None,
                    },
                ],
                'taskRunCounts': {'SCORED': 3, 'RUNNING': 2},
                'meanScore': 0.75,
                'error': None,
                'updatedAt': '2026-07-22T00:05:00.000Z',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).get('eval-1')

        assert evaluation.status == 'RUNNING'
        # Status-histogram keys are statuses, not camelCase — they pass through
        assert evaluation.task_run_counts == {'SCORED': 3, 'RUNNING': 2}
        assert evaluation.mean_score == 0.75
        assert not hasattr(evaluation, 'task_run_total')
        # No benchmark-lifecycle internals on the evaluation resource
        assert not hasattr(evaluation, 'benchmark_version_state')
        system = evaluation.agent_systems[0]
        assert (system.harness, system.model, system.harness_version) == ('codex', 'gpt-5.5', None)
        assert not hasattr(system, 'id')
        assert not hasattr(system, 'system_digest')

    @pytest.mark.asyncio
    async def test_list_builds_cursor_params(self):
        fake = FakeUrlopen([
            ('/api/evaluations', {
                'evaluations': [{**RUN_SUMMARY, 'taskRunCounts': {'SCORED': 5}, 'meanScore': 0.4}],
                'nextCursor': 'eval-0',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await evaluations_factory(CONFIG).list(limit=100, cursor='eval-5')

        url = fake.requests[0].full_url
        assert 'limit=100' in url and 'cursor=eval-5' in url
        assert page.next_cursor == 'eval-0'
        assert page.evaluations[0].task_run_counts == {'SCORED': 5}
        assert page.evaluations[0].mean_score == 0.4
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
                'sandboxProvider': None,
                'verifierMode': None,
                'resolvedHarnessVersion': None,
                'sessionRef': None,
                'createdAt': '2026-07-22T00:00:00.000Z',
                'updatedAt': '2026-07-22T00:00:00.000Z',
            }

        pages = {
            None: {'taskRuns': [_run('run-1', 1), _run('run-2', 2)], 'nextCursor': 'run-2'},
            'run-2': {'taskRuns': [_run('run-3', 3)], 'nextCursor': None},
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
        # Await form still returns a single page.
        with patch('evolve.hosted.urllib.request.urlopen', PagedUrlopen([])) as _:
            single = await evaluations_factory(CONFIG).task_runs('eval-1', limit=2)
        assert len(single.task_runs) == 2
        assert single.next_cursor == 'run-2'

    @pytest.mark.asyncio
    async def test_task_runs_mapping_and_status_filter(self):
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
                        'modelUsage': {'spentUsd': 0.93, 'spendSource': 'measured'},
                        'sandboxProvider': 'daytona',
                        'verifierMode': 'separate',
                        'resolvedHarnessVersion': 'codex-cli 0.145.0',
                        'sessionRef': 'sess-9',
                        'createdAt': '2026-07-22T00:00:00.000Z',
                        'updatedAt': '2026-07-22T00:04:00.000Z',
                    },
                ],
                'nextCursor': None,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await evaluations_factory(CONFIG).task_runs(
                'eval-1', status=['SCORED', 'SCORING_ERROR'], limit=1
            )

        url = fake.requests[0].full_url
        assert 'limit=1' in url
        assert 'status=SCORED%2CSCORING_ERROR' in url
        run = page.task_runs[0]
        assert run.score == 1
        assert run.metrics == {'f2p': 1.0}
        # Wire camelCase never reaches the user: typed ModelUsage + snake_case timings
        assert run.model_usage.spent_usd == 0.93
        assert run.model_usage.spend_source == 'measured'
        assert run.phase_timings_ms == {'agent_ms': 203000}
        # First-class run facts on list rows — same shape as the detail route
        assert run.sandbox_provider == 'daytona'
        assert run.verifier_mode == 'separate'
        assert run.resolved_harness_version == 'codex-cli 0.145.0'
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
    async def test_regrade_task_run_evaluation_and_job(self):
        result_wire = {
            'id': 'rr-1',
            'sourceTaskRunId': 'run-1',
            'taskKey': 'demo-task',
            'status': 'SCORED',
            'score': 0.5,
            'metrics': {'f2p': 0.5},
            'sourceScore': 1,
            'sourceStatus': 'SCORED',
            'scoreDelta': -0.5,
            'verifierMode': 'separate',
            'verifierDigest': 'abcd',
            'verifierSandboxId': 'sbx-1',
            'failurePhase': None,
            'failureDetail': None,
            'phaseTimingsMs': {'verifyMs': 1200},
            'createdAt': '2026-07-24T00:00:00Z',
            'settledAt': '2026-07-24T00:05:00Z',
        }
        job_wire = {
            'id': 'job-1',
            'sourceEvaluationId': 'eval-1',
            'status': 'COMPLETED',
            'sandboxProvider': 'e2b',
            'filter': {'taskKey': 'demo-task'},
            'counts': {'results': 1, 'byStatus': {'SCORED': 1}},
            'createdAt': '2026-07-24T00:00:00Z',
            'updatedAt': '2026-07-24T00:05:00Z',
            'results': [result_wire],
        }
        fake = FakeUrlopen([
            ('/task-runs/run-1/regrade', {**job_wire, 'counts': {'results': 1, 'byStatus': {'QUEUED': 1}}}),
            ('/eval-1/regrade', {**job_wire, 'counts': {'results': 2, 'byStatus': {'QUEUED': 2}}}),
            ('/api/regrades/job-1', job_wire),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = evaluations_factory(CONFIG)
            per_run = await client.regrade_task_run('eval-1', 'run-1')
            per_eval = await client.regrade('eval-1', status=['SCORED'], task_key='demo-task')
            read = await client.regrade_job('job-1')

        # Per-run regrade: POST the per-run route, one queued result.
        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/task-runs/run-1/regrade')
        assert per_run.id == 'job-1'
        assert per_run.source_evaluation_id == 'eval-1'
        assert per_run.counts.results == 1

        # Per-evaluation regrade: POST the filter body.
        assert fake.requests[1].get_method() == 'POST'
        sent = json.loads(fake.requests[1].data.decode('utf-8'))
        assert sent == {'status': ['SCORED'], 'taskKey': 'demo-task'}
        assert per_eval.counts.results == 2

        # Read: results mapped with immutable source snapshots + delta + lineage.
        assert read.status == 'COMPLETED'
        assert read.filter.task_key == 'demo-task'
        assert read.results is not None and len(read.results) == 1
        result = read.results[0]
        assert result.task_key == 'demo-task'
        assert result.source_score == 1
        assert result.score_delta == -0.5
        assert result.verifier_digest == 'abcd'
        assert result.verifier_mode == 'separate'
        assert result.phase_timings_ms == {'verify_ms': 1200}

    @pytest.mark.asyncio
    async def test_regrade_ineligible_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'regrade_source_ineligible',
                    'message': 'Run used a shared-mode verifier; nothing faithful to re-run.',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await evaluations_factory(CONFIG).regrade_task_run('eval-1', 'run-1')
        assert exc.value.status == 409
        assert exc.value.code == 'regrade_source_ineligible'

    @pytest.mark.asyncio
    async def test_export_bytes_and_streamed_file(self, tmp_path):
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
    async def test_export_rejects_unknown_format(self):
        with pytest.raises(ValueError, match='harbor'):
            await evaluations_factory(CONFIG).export('eval-1', format='zip')

    # ------------------------------------------------------------------ watch

    @pytest.mark.asyncio
    async def test_watch_streams_events_to_terminal(self):
        stream = sse_text([
            {'seq': 0, 'type': 'evaluation.created', 'data': {'taskRunCount': 2}},
            {'seq': 1, 'type': 'task_run.settled', 'data': {'taskRunId': 'run-1', 'status': 'SCORED', 'score': 1}},
        ]) + ': heartbeat\n\n' + sse_text([
            {'seq': 2, 'type': 'evaluation.completed', 'data': {'scored': 2}},
        ])

        class WatchUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    return FakeSseResponse(stream.encode('utf-8'))
                return FakeResponse({**RUN_SUMMARY, 'status': 'COMPLETED'})

        fake = WatchUrlopen([])
        events = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            final = await evaluations_factory(CONFIG).watch(
                'eval-1', on_event=lambda e: events.append(e)
            )

        assert [e.seq for e in events] == [0, 1, 2]
        assert events[0].type == 'evaluation.created'
        assert events[0].data == {'taskRunCount': 2}
        assert events[2].type == 'evaluation.completed'
        assert final.status == 'COMPLETED'
        stream_request = next(r for r in fake.requests if '/events' in r.full_url)
        assert stream_request.get_header('Accept') == 'text/event-stream'
        assert stream_request.get_header('Last-event-id') is None

    @pytest.mark.asyncio
    async def test_watch_iter_yields_events_until_terminal(self):
        stream = sse_text([
            {'seq': 0, 'type': 'evaluation.created', 'data': {}},
            {'seq': 1, 'type': 'evaluation.completed', 'data': {}},
        ])

        class WatchUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    return FakeSseResponse(stream.encode('utf-8'))
                return FakeResponse({**RUN_SUMMARY, 'status': 'COMPLETED'})

        fake = WatchUrlopen([])
        seqs = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for event in evaluations_factory(CONFIG).watch_iter('eval-1'):
                seqs.append(event.seq)

        assert seqs == [0, 1]

    @pytest.mark.asyncio
    async def test_watch_resumes_with_last_event_id(self):
        connects = {'count': 0}

        class ReconnectUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    connects['count'] += 1
                    if connects['count'] == 1:
                        return FakeSseResponse(sse_text([
                            {'seq': 0, 'type': 'evaluation.created', 'data': {}},
                            {'seq': 1, 'type': 'task_run.running', 'data': {'taskRunId': 'run-1'}},
                        ]).encode('utf-8'))
                    return FakeSseResponse(sse_text([
                        {'seq': 2, 'type': 'evaluation.completed', 'data': {}},
                    ]).encode('utf-8'))
                status = 'COMPLETED' if connects['count'] >= 2 else 'RUNNING'
                return FakeResponse({**RUN_SUMMARY, 'status': status})

        fake = ReconnectUrlopen([])
        events = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            final = await evaluations_factory(CONFIG).watch(
                'eval-1', on_event=lambda e: events.append(e), reconnect_delay_s=0.001
            )

        assert connects['count'] == 2
        second_connect = [r for r in fake.requests if '/events' in r.full_url][1]
        assert second_connect.get_header('Last-event-id') == '1'
        assert [e.seq for e in events] == [0, 1, 2]
        assert final.status == 'COMPLETED'

    @pytest.mark.asyncio
    async def test_watch_finishes_on_terminal_status_without_terminal_event(self):
        connects = {'count': 0}

        class QuietCloseUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    connects['count'] += 1
                    return FakeSseResponse(sse_text([
                        {'seq': 0, 'type': 'evaluation.created', 'data': {}},
                    ]).encode('utf-8') if connects['count'] == 1 else b'')
                return FakeResponse({**RUN_SUMMARY, 'status': 'CANCELLED'})

        fake = QuietCloseUrlopen([])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            final = await evaluations_factory(CONFIG).watch('eval-1', reconnect_delay_s=0.001)

        assert final.status == 'CANCELLED'
        # Terminal-status fallback drains ONCE more from last_seq, then finishes.
        assert connects['count'] == 2

    @pytest.mark.asyncio
    async def test_watch_timeout(self):
        class NeverTerminalUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    return FakeSseResponse(b'')
                return FakeResponse({**RUN_SUMMARY, 'status': 'RUNNING'})

        fake = NeverTerminalUrlopen([])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(TimeoutError):
                await evaluations_factory(CONFIG).watch(
                    'eval-1', reconnect_delay_s=0.001, timeout_s=0.05
                )

    @pytest.mark.asyncio
    async def test_watch_raises_typed_error_on_404(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({
                    'error': {'code': 'evaluation_not_found', 'message': 'Evaluation not found: eval-x'},
                }).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await evaluations_factory(CONFIG).watch('eval-x')
        assert exc_info.value.status == 404
        assert exc_info.value.code == 'evaluation_not_found'
        assert 'Evaluation not found: eval-x' in str(exc_info.value)

    # ---------------------------------------------------------------- shapes

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
        assert list(body) == ['benchmark', 'agentSystems', 'maxModelSpendUsd', 'maxModelSpendUsdPerTaskRun']
        assert evaluation.max_model_spend_usd_per_task_run == 2

    @pytest.mark.asyncio
    async def test_run_omits_absent_spend_cap(self):
        # max_model_spend_usd is optional: the server applies its own default
        # ($500, operator-tunable) and the response echoes the RESOLVED cap.
        fake = FakeUrlopen([
            ('/api/evaluations', {**RUN_SUMMARY, 'maxModelSpendUsd': 500}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # ABSENT, never None: an explicit null would defeat the server-side
        # default the omission is asking for.
        assert 'maxModelSpendUsd' not in body
        assert body == {
            'benchmark': 'deep-swe@1.1',
            'agentSystems': [{'harness': 'codex', 'model': 'gpt-5.5'}],
        }
        assert evaluation.max_model_spend_usd == 500

    @pytest.mark.asyncio
    async def test_run_forwards_stated_spend_cap(self):
        fake = FakeUrlopen([('/api/evaluations', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                max_model_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['maxModelSpendUsd'] == 25
        assert list(body) == ['benchmark', 'agentSystems', 'maxModelSpendUsd']

    @pytest.mark.asyncio
    async def test_run_posts_sandbox_provider(self):
        fake = FakeUrlopen([
            ('/api/evaluations', {**RUN_SUMMARY, 'sandboxProvider': 'daytona'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            evaluation = await evaluations_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agent_systems=[AgentSystem(harness='codex', model='gpt-5.5')],
                max_model_spend_usd=25,
                sandbox_provider='daytona',
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['sandboxProvider'] == 'daytona'
        assert evaluation.sandbox_provider == 'daytona'

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
                'modelUsage': {
                    'spentUsd': 0.93,
                    'spendSource': 'measured',
                    'maxModelSpendUsd': 2,
                    'inputTokens': 1234,
                },
                'sandboxProvider': 'e2b',
                'verifierMode': 'shared',
                'resolvedHarnessVersion': '0.29.0',
                'sessionRef': 'sess-9',
                'createdAt': '2026-07-22T00:00:00.000Z',
                'updatedAt': '2026-07-22T00:04:00.000Z',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            run = await evaluations_factory(CONFIG).task_run('eval-1', 'run-1')

        assert '/api/evaluations/eval-1/task-runs/run-1' in fake.requests[0].full_url
        assert run.evaluation_id == 'eval-1'
        assert run.resolved_harness_version == '0.29.0'
        assert run.sandbox_provider == 'e2b'
        assert run.verifier_mode == 'shared'
        assert run.phase_timings_ms == {'agent_ms': 203000, 'verify_ms': 41000}
        usage = run.model_usage
        # One money vocabulary: actuals are spent_usd, caps are max_model_spend*
        assert usage.spent_usd == 0.93
        assert usage.spend_source == 'measured'
        assert usage.max_model_spend_usd == 2
        # Unknown harness-specific keys land in extra, snake_cased
        assert usage.extra == {'input_tokens': 1234}
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

        # With an explicit page limit, a short page ends the drain without an
        # extra empty-page request (same rule as the TypeScript SDK).
        fake_limited = PagedUrlopen([])
        seqs_limited = []
        with patch('evolve.hosted.urllib.request.urlopen', fake_limited):
            async for event in evaluations_factory(CONFIG).task_run_trace_events(
                'eval-1', 'run-1', limit=2
            ):
                seqs_limited.append(event.seq)
        assert seqs_limited == [1, 2, 3]
        afters_limited = [
            urllib_parse.parse_qs(urllib_parse.urlsplit(r.full_url).query).get('after', [None])[0]
            for r in fake_limited.requests
        ]
        assert afters_limited == [None, '2']

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
                                'meanScore': 1,
                                'coverage': {'scored': 1, 'total': 1},
                            },
                            {
                                'evaluationId': 'eval-2',
                                'status': 'MISSING',
                                'meanScore': None,
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
        # Same statistic, same name, at every level of the compare payload
        assert row.cells[0].mean_score == 1
        assert row.cells[1].status == 'MISSING'
        assert row.cells[1].mean_score is None

    @pytest.mark.asyncio
    async def test_export_harbor_format(self):
        archive = gzip.compress(b'{}')
        fake = FakeUrlopen([('/export', archive)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            payload = await evaluations_factory(CONFIG).export('eval-1', format='harbor')

        assert 'format=harbor' in fake.requests[0].full_url
        assert payload == archive

    @pytest.mark.asyncio
    async def test_http_error_is_typed(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({
                    'error': {
                        'code': 'evaluation_not_terminal',
                        'message': 'Evaluation is RUNNING; export requires a terminal evaluation',
                    },
                }).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await evaluations_factory(CONFIG).export('eval-1')
        error = exc_info.value
        assert error.status == 409
        assert error.code == 'evaluation_not_terminal'
        # The message is the clean product sentence — no JSON, no status prefix
        assert str(error) == 'Evaluation is RUNNING; export requires a terminal evaluation'

    @pytest.mark.asyncio
    async def test_http_error_unparseable_body(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 502, 'Bad Gateway', {},
                io.BytesIO(b'Bad Gateway'),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await evaluations_factory(CONFIG).get('eval-1')
        assert exc_info.value.status == 502
        assert exc_info.value.code == 'unknown_error'
