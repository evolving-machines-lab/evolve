"""
Unit tests for the standalone hosted-evals clients
(benchmarks/custom_harnesses/jobs).

Coverage:
- benchmarks().list()/get() — catalog + detail mapping (selected_version,
  per-task provider verdicts), name@version refs
- custom_harnesses().create()/list()/get()/delete() — ONE registration body
  grammar (multipart/form-data: an installScript part or a file part; the run
  command and env are named parts, never query string), owner-private
  not-found, name-taken
- benchmarks().get_active() — runnable shape (non-optional version/tasks) + NoActiveVersionError
- benchmarks().import_benchmark()/get_import()/watch_import() — git import flow
  (self-describing jobs; the shared job vocabulary QUEUED -> RUNNING ->
  COMPLETED | FAILED, with COMPLETED/FAILED terminal)
- jobs().run() — contract body (field order), Idempotency-Key header
- jobs().get()/list()/trials() — mapping + cursor params + status filter
- jobs().list()/trials() — await one page + async-for auto-pagination across cursors
- jobs().trial()/trial_trace()/trial_artifact()/compare() — detail, trace
  paging, raw artifacts, comparison
- jobs().cancel()/rerun_failed() — POST semantics
- jobs().export() — bytes, streamed-to-file, and format='harbor' modes
- jobs().watch()/watch_iter() — SSE event stream: replay, Last-Event-ID
  resume on reconnect, terminal-event completion, timeout
- EvolveAPIError — typed {error: {code, message}} mapping
- Internal fields (agent ids/digests) never leak

Mocks urllib at the module boundary; no real network calls.
"""

import asyncio
import gzip
import hashlib
import json
import os
import typing
import urllib.parse as urllib_parse
from typing import Dict
from unittest.mock import patch

import pytest

from evolve import (
    JobAgent,
    JobCounts,
    JobFailure,
    EvolveAPIError,
    EvolveDigestMismatchError,
    EvolveIncompleteDownloadError,
    HostedClientConfig,
    NoActiveVersionError,
    TaskProviderVerdict,
    benchmarks as benchmarks_factory,
    custom_harnesses as custom_harnesses_factory,
    jobs as jobs_factory,
)


def _multipart_parts(request):
    """Split a multipart/form-data request body into {part name: raw bytes}.

    Named parts are how metadata travels now: a run command and a set of
    environment values in a URL land in every access log and proxy buffer.
    """
    content_type = request.get_header('Content-type')
    boundary = content_type.split('boundary=', 1)[1]
    parts = {}
    for chunk in request.data.split(f'--{boundary}'.encode('utf-8')):
        if not chunk.strip() or chunk.startswith(b'--'):
            continue
        head, _, body = chunk.partition(b'\r\n\r\n')
        header_text = head.decode('utf-8', errors='replace')
        name = header_text.split('name="', 1)[1].split('"', 1)[0]
        parts[name] = body[:-2] if body.endswith(b'\r\n') else body
    return parts


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

ZERO_TRIAL_STATUSES = {
    'QUEUED': 0,
    'RUNNING': 0,
    'SCORING': 0,
    'SCORED': 0,
    'SCORING_ERROR': 0,
    'INFRASTRUCTURE_ERROR': 0,
    'INDETERMINATE': 0,
    'CANCELLED': 0,
}


def trial_tally(**counts):
    """A trial tally with EVERY status named — zeros included, as the API emits."""
    by_status = {**ZERO_TRIAL_STATUSES, **counts}
    return {'total': sum(by_status.values()), 'byStatus': by_status}


# THE job wire shape — the same fields from every call (create, get, list,
# cancel, rerun), so a client never asks which one it is holding.
RUN_SUMMARY = {
    'id': 'job-1',
    'status': 'QUEUED',
    'benchmark': 'deep-swe@1.1',
    'agents': [{'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None}],
    'runsPerTask': 1,
    'concurrency': 4,
    'maxTrialSpendUsd': 25,
    'worstCaseSpendUsd': 125,
    'sandboxProvider': 'e2b',
    'spentUsd': 0,
    'counts': {'agents': 1, 'tasks': 5},
    'trials': trial_tally(QUEUED=5),
    'meanReward': None,
    'failure': None,
    'sourceJobId': None,
    'idempotentReplay': False,
    'createdAt': '2026-07-22T00:00:00.000Z',
    'updatedAt': '2026-07-22T00:00:00.000Z',
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
        client = jobs_factory(CONFIG)
        assert client._http.api_key() == 'test-key'
        assert client._http.base_url() == 'http://localhost:3000'


class TestBenchmarks:
    @pytest.mark.asyncio
    async def test_list_maps_catalog(self):
        fake = FakeUrlopen([
            ('/api/benchmarks', {
                'items': [
                    {
                        'name': 'deep-swe',
                        'title': 'DeepSWE',
                        'description': 'SWE tasks',
                        'activeVersion': {'version': '1.1', 'state': 'READY', 'createdAt': '2026-07-21', 'taskCount': 113},
                    },
                    {'name': 'empty', 'title': None, 'description': None, 'activeVersion': None},
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            catalog = await benchmarks_factory(CONFIG).list()

        # The one page envelope, the same on every collection.
        assert len(catalog.items) == 2
        assert catalog.next_cursor is None
        assert catalog.has_more is False
        assert catalog.items[0].name == 'deep-swe'
        assert catalog.items[0].title == 'DeepSWE'
        assert catalog.items[0].active_version.version == '1.1'
        assert catalog.items[0].active_version.created_at == '2026-07-21'
        assert catalog.items[0].active_version.task_count == 113
        assert catalog.items[1].active_version is None
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
                'tasks': {
                    'items': [
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
                    'nextCursor': 'task-1',
                    'hasMore': True,
                },
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
        # A nested collection is the same envelope as a top-level one.
        assert detail.tasks.has_more is True
        assert detail.tasks.next_cursor == 'task-1'
        task = detail.tasks.items[0]
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
                'tasks': {
                    'items': [
                        {
                            'taskKey': 'abs-module-cache-flags',
                            'agentTimeoutSec': 5400,
                            'verifierTimeoutSec': 1800,
                            'providers': ALL_OK_PROVIDERS,
                        },
                    ],
                    'nextCursor': None,
                    'hasMore': False,
                },
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
        assert len(active.tasks.items) == 1            # non-optional
        assert active.tasks.items[0].task_key == 'abs-module-cache-flags'
        assert active.tasks.items[0].providers['daytona'].ok is True
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
                'tasks': {'items': [], 'nextCursor': None, 'hasMore': False},
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
                'id': 'imp-1', 'status': 'QUEUED', 'benchmarkName': 'my-benchmark', 'version': '1.2',
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
        # ONE body grammar: multipart/form-data with named parts. Nothing rides
        # the query string, where it would land in access logs.
        assert request.full_url.endswith('/api/benchmarks/imports')
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts == {
            'benchmarkName': b'my-benchmark',
            'version': b'1.2',
            'gitUrl': b'https://github.com/org/bench.git',
            'ref': b'v1.2.0',
        }
        assert job.id == 'imp-1'
        assert job.status == 'QUEUED'
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
                'id': 'imp-9', 'status': 'QUEUED', 'benchmarkName': 'my-bench', 'version': '0.1',
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
        # Metadata is named PARTS; the corpus is the `file` part. The URL is bare.
        assert request.full_url.endswith('/api/benchmarks/imports')
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts['benchmarkName'] == b'my-bench'
        assert parts['version'] == b'0.1'

        data = parts['file']
        assert data[:2] == b'\x1f\x8b'  # gzip magic
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r') as tar:
            names = tar.getnames()
        assert 'tasks/abc/task.toml' in names

        # Deterministic: the same directory always tars to the same bytes.
        assert _tar_gzip_directory(str(tmp_path)) == _tar_gzip_directory(str(tmp_path))

        assert job.id == 'imp-9'
        assert job.status == 'QUEUED'
        assert job.benchmark_name == 'my-bench'

    @pytest.mark.asyncio
    async def test_get_import_maps_status(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/imports/imp-1', {
                'id': 'imp-1', 'status': 'COMPLETED', 'benchmarkName': 'my-benchmark',
                'version': '1.2', 'taskCount': 113, 'failure': None,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).get_import('imp-1')

        assert job.id == 'imp-1'
        assert job.status == 'COMPLETED'
        # Self-describing: a watcher holding only the id learns what it watches
        assert job.benchmark_name == 'my-benchmark'
        assert job.version == '1.2'
        assert job.task_count == 113
        assert job.failure is None

    @pytest.mark.asyncio
    async def test_get_import_maps_structured_error_to_snake_case(self):
        fake = FakeUrlopen([
            ('/api/benchmarks/imports/imp-2', {
                'id': 'imp-2',
                'status': 'FAILED',
                'benchmarkName': 'my-benchmark',
                'version': '1.2',
                'failure': {
                    'code': 'import_failed',
                    'message': '1/2 task(s) failed to parse',
                    'failures': [{'taskKey': 'bad-task', 'error': 'boom'}],
                },
                'taskCount': 0,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await benchmarks_factory(CONFIG).get_import('imp-2')

        assert job.status == 'FAILED'
        assert job.failure is not None
        assert job.failure.message == '1/2 task(s) failed to parse'
        # Wire camelCase (taskKey) never reaches Python users
        assert job.failure.failures[0].task_key == 'bad-task'
        assert job.failure.failures[0].error == 'boom'

    @pytest.mark.asyncio
    async def test_watch_import_polls_until_terminal(self):
        job = {'id': 'imp-1', 'benchmarkName': 'my-benchmark', 'version': '1.2'}
        responses = iter([
            {**job, 'status': 'QUEUED'},
            {**job, 'status': 'RUNNING', 'taskCount': 0},
            {**job, 'status': 'COMPLETED', 'taskCount': 113},
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

        assert done.status == 'COMPLETED'
        assert done.task_count == 113
        assert len(fake.requests) == 3
        assert statuses == ['QUEUED', 'RUNNING', 'COMPLETED']

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
    async def test_create_posts_the_install_script_as_named_parts(self):
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
        # ONE body grammar for both sources: multipart/form-data. The endpoint
        # no longer switches grammars on Content-Type.
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts == {
            'name': b'acme-cli',
            'runCommand': b'acme-cli --headless',
            'env': b'{"ACME_PROFILE": "bench"}',
            'installScript': b'curl -fsSL https://acme.dev/install.sh | sh',
        }

        assert harness.name == 'acme-cli'
        assert harness.source == 'install_script'
        assert harness.run_command == 'acme-cli --headless'
        assert harness.env == {'ACME_PROFILE': 'bench'}
        assert harness.created_at == '2026-07-24T00:00:00Z'

    @pytest.mark.asyncio
    async def test_create_uploads_a_directory_with_metadata_in_named_parts(self, tmp_path):
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
        # THE LEAK A6 CLOSES: the run command and the declared env used to ride
        # the query string, which put a shell command and a set of environment
        # values into every access log and proxy buffer on the way here.
        assert request.full_url.endswith('/api/custom-harnesses')
        assert urllib_parse.urlparse(request.full_url).query == ''
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts['name'] == b'acme-cli'
        assert parts['runCommand'] == b'acme-cli --headless'
        assert json.loads(parts['env']) == {'ACME_PROFILE': 'bench', 'ACME_REGION': 'us'}

        data = parts['file']
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
            ('/api/custom-harnesses', {
                'items': [CUSTOM_HARNESS], 'nextCursor': None, 'hasMore': False,
            }),
        ])
        # get() must resolve the detail route, so answer it before the list route.
        get_fake = FakeUrlopen([('/api/custom-harnesses/acme-cli', CUSTOM_HARNESS)])

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            listed = await custom_harnesses_factory(CONFIG).list()
        assert [harness.name for harness in listed.items] == ['acme-cli']
        assert listed.items[0].source == 'install_script'
        assert listed.next_cursor is None
        assert listed.has_more is False

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


class TestJobs:
    @pytest.mark.asyncio
    async def test_run_posts_contract_body_in_field_order(self):
        fake = FakeUrlopen([('/api/jobs', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                tasks=['abs-module-cache-flags'],
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
                runs_per_task=1,
                concurrency=4,
                max_trial_spend_usd=25,
                idempotency_key='idem-abc',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        body = json.loads(request.data.decode('utf-8'))
        assert body == {
            'benchmark': 'deep-swe@1.1',
            'tasks': ['abs-module-cache-flags'],
            'agents': [{'harness': 'codex', 'model': 'gpt-5.5'}],
            'runsPerTask': 1,
            'concurrency': 4,
            'maxTrialSpendUsd': 25,
        }
        # Wire body is emitted in the contract's field order
        assert list(body) == [
            'benchmark', 'tasks', 'agents', 'runsPerTask', 'concurrency', 'maxTrialSpendUsd',
        ]
        assert request.get_header('Idempotency-key') == 'idem-abc'
        assert job.id == 'job-1'
        assert job.sandbox_provider == 'e2b'
        # ONE "how many" structure: counts is entity cardinality, trials is the
        # total plus the status histogram.
        assert job.counts == JobCounts(agents=1, tasks=5)
        assert job.trials.total == 5
        assert job.trials.by_status['QUEUED'] == 5
        assert job.idempotent_replay is False

    @pytest.mark.asyncio
    async def test_run_accepts_snake_case_agent_dicts(self):
        fake = FakeUrlopen([('/api/jobs', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agents=[{'harness': 'codex', 'model': 'gpt-5.5', 'harness_version': '0.29.0'}],
                max_trial_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['agents'] == [
            {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': '0.29.0'},
        ]
        # camelCase keys are not part of the Python surface
        with pytest.raises(TypeError):
            await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agents=[{'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': '0.29.0'}],
                max_trial_spend_usd=25,
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
                await jobs_factory(CONFIG).run(
                    benchmark='deep-swe',
                    agents=[
                        JobAgent(harness='codex', model='gpt-5.5', harness_version='9.9.9'),
                    ],
                    max_trial_spend_usd=25,
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
                    'message': 'Your account is out of credits; add credits before starting a job',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await jobs_factory(CONFIG).run(
                    benchmark='deep-swe',
                    agents=[JobAgent(harness='codex', model='gpt-5.5')],
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
                await jobs_factory(CONFIG).run(
                    benchmark='deep-swe',
                    # A range cannot hold a comparison still, so it is refused.
                    agents=[
                        JobAgent(harness='codex', model='gpt-5.5', harness_version='^0.29.0'),
                    ],
                    max_trial_spend_usd=25,
                )
        assert exc.value.status == 400
        # A non-exact pin is invalid_input, not harness_version_not_found
        assert exc.value.code == 'invalid_input'
        assert 'exact version' in str(exc.value)

    @pytest.mark.asyncio
    async def test_unpinned_agent_sends_no_harness_version(self):
        fake = FakeUrlopen([('/api/jobs', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await jobs_factory(CONFIG).run(
                benchmark='deep-swe',
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
                max_trial_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # Omitted = resolve latest at dispatch; the key is absent, never null.
        assert body['agents'] == [{'harness': 'codex', 'model': 'gpt-5.5'}]

    @pytest.mark.asyncio
    async def test_get_maps_detail_and_drops_internal_fields(self):
        fake = FakeUrlopen([
            ('/api/jobs/job-1', {
                **RUN_SUMMARY,
                'status': 'RUNNING',
                'agents': [
                    {
                        'harness': 'codex',
                        'model': 'gpt-5.5',
                        'harnessVersion': None,
                    },
                ],
                'trials': trial_tally(SCORED=3, RUNNING=2),
                'meanReward': 0.75,
                'failure': None,
                'updatedAt': '2026-07-22T00:05:00.000Z',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await jobs_factory(CONFIG).get('job-1')

        assert job.status == 'RUNNING'
        # Status-histogram keys are statuses, not camelCase — they pass through,
        # and EVERY status is named so a UI never hardcodes the enum.
        assert job.trials.total == 5
        assert job.trials.by_status['SCORED'] == 3
        assert job.trials.by_status['CANCELLED'] == 0
        assert len(job.trials.by_status) == 8
        assert job.mean_reward == 0.75
        assert job.failure is None
        # `error` is the FAILURE envelope's key; it is never on a 200 body.
        assert not hasattr(job, 'error')
        assert not hasattr(job, 'trial_counts')
        # No benchmark-lifecycle internals on the job resource
        assert not hasattr(job, 'benchmark_version_state')
        agent = job.agents[0]
        assert (agent.harness, agent.model, agent.harness_version) == ('codex', 'gpt-5.5', None)
        assert not hasattr(agent, 'id')
        assert not hasattr(agent, 'system_digest')

    @pytest.mark.asyncio
    async def test_list_builds_cursor_params(self):
        fake = FakeUrlopen([
            ('/api/jobs', {
                'items': [{
                    **RUN_SUMMARY, 'trials': trial_tally(SCORED=5), 'meanReward': 0.4,
                }],
                'nextCursor': 'job-0',
                'hasMore': True,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await jobs_factory(CONFIG).list(limit=100, cursor='job-5')

        url = fake.requests[0].full_url
        assert 'limit=100' in url and 'cursor=job-5' in url
        assert page.next_cursor == 'job-0'
        assert page.has_more is True
        # A list row is the SAME shape as a get(): agents, failure and the
        # histogram ride along, so a dashboard needs no N+1 detail call.
        assert page.items[0].trials.by_status['SCORED'] == 5
        assert page.items[0].mean_reward == 0.4
        assert page.items[0].agents[0].harness == 'codex'
        assert page.items[0].failure is None
        # Awaiting the handle fetches exactly one page (no cursor walk).
        assert len(fake.requests) == 1

    @pytest.mark.asyncio
    async def test_every_job_response_is_the_same_shape(self):
        """A1: create, get and each list row carry the same fields.

        The rule this replaces: five responses, four different Job shapes, and a
        client that had to remember which call produced the one in its hand.
        """
        fake = FakeUrlopen([
            ('/api/jobs/job-1', RUN_SUMMARY),
            ('/api/jobs', {'items': [RUN_SUMMARY], 'nextCursor': None, 'hasMore': False}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = jobs_factory(CONFIG)
            got = await client.get('job-1')
            listed = (await client.list()).items[0]

        assert vars(got).keys() == vars(listed).keys()
        # ...and it is the FULL shape, not a shared subset.
        assert sorted(vars(got)) == [
            'agents',
            'benchmark',
            'concurrency',
            'counts',
            'created_at',
            'failure',
            'id',
            'idempotent_replay',
            'max_trial_spend_usd',
            'mean_reward',
            'runs_per_task',
            'sandbox_provider',
            'source_job_id',
            'spent_usd',
            'status',
            'trials',
            'updated_at',
            'worst_case_spend_usd',
        ]

    @pytest.mark.asyncio
    async def test_failed_job_says_why_on_every_response(self):
        """A3: the reason is `failure` ({code, message}), never `error`.

        `error` is the FAILURE envelope's key, so `if body.error: raise` has to
        stay correct on a healthy 200 read of a failed job — and the reason
        rides on LIST rows, so a dashboard needs no detail call per row.
        """
        failed = {
            **RUN_SUMMARY,
            'status': 'FAILED',
            'failure': {'code': 'job_execution_failed', 'message': 'dispatch exploded'},
        }
        fake = FakeUrlopen([
            ('/api/jobs', {'items': [failed], 'nextCursor': None, 'hasMore': False}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            row = (await jobs_factory(CONFIG).list()).items[0]

        assert row.failure == JobFailure(code='job_execution_failed', message='dispatch exploded')
        assert not hasattr(row, 'error')

    @pytest.mark.asyncio
    async def test_list_auto_paginates_when_iterated(self):
        pages = {
            None: {
                'items': [{**RUN_SUMMARY, 'id': 'job-2'}, {**RUN_SUMMARY, 'id': 'job-1'}],
                'nextCursor': 'job-1',
                'hasMore': True,
            },
            'job-1': {
                'items': [{**RUN_SUMMARY, 'id': 'job-0'}],
                'nextCursor': None,
                'hasMore': False,
            },
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
            async for job in jobs_factory(CONFIG).list():
                ids.append(job.id)

        assert ids == ['job-2', 'job-1', 'job-0']
        cursors = [
            urllib_parse.parse_qs(urllib_parse.urlsplit(r.full_url).query).get('cursor', [None])[0]
            for r in fake.requests
        ]
        assert cursors == [None, 'job-1']

    @pytest.mark.asyncio
    async def test_trials_auto_paginates_when_iterated(self):
        def _run(trial_id, run_number):
            return {
                'id': trial_id,
                'taskKey': 'abs-module-cache-flags',
                'agent': {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None},
                'runNumber': run_number,
                'status': 'SCORED',
                'reward': 1,
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
            None: {
                'items': [_run('run-1', 1), _run('run-2', 2)],
                'nextCursor': 'run-2',
                'hasMore': True,
            },
            'run-2': {'items': [_run('run-3', 3)], 'nextCursor': None, 'hasMore': False},
        }

        class PagedUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                query = urllib_parse.parse_qs(urllib_parse.urlsplit(request.full_url).query)
                cursor = query.get('cursor', [None])[0]
                return FakeResponse(pages[cursor])

        fake = PagedUrlopen([])
        trial_ids = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for run in jobs_factory(CONFIG).trials('job-1'):
                trial_ids.append(run.id)

        assert trial_ids == ['run-1', 'run-2', 'run-3']
        # Await form still returns a single page.
        with patch('evolve.hosted.urllib.request.urlopen', PagedUrlopen([])) as _:
            single = await jobs_factory(CONFIG).trials('job-1', limit=2)
        assert len(single.items) == 2
        assert single.next_cursor == 'run-2'
        assert single.has_more is True

    @pytest.mark.asyncio
    async def test_trials_mapping_and_status_filter(self):
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [
                    {
                        'id': 'run-1',
                        'taskKey': 'abs-module-cache-flags',
                        'agent': {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None},
                        'runNumber': 1,
                        'status': 'SCORED',
                        'reward': 1,
                        'metrics': {'f2p': 1.0},
                        'failurePhase': None,
                        'failureDetail': None,
                        'phaseTimingsMs': {'agentMs': 203000},
                        'modelUsage': None,
                        'spentUsd': 0.93,
                        'spendSource': 'measured',
                        'sandboxProvider': 'daytona',
                        'verifierMode': 'separate',
                        'resolvedHarnessVersion': 'codex-cli 0.145.0',
                        'sandboxId': 'im8f0wgqwehvng70evvro',
                        'verifierSandboxId': 'iv2k1xbqwehvng70evvrp',
                        'sessionRef': 'sess-9',
                        'createdAt': '2026-07-22T00:00:00.000Z',
                        'updatedAt': '2026-07-22T00:04:00.000Z',
                    },
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await jobs_factory(CONFIG).trials(
                'job-1', status=['SCORED', 'SCORING_ERROR'], limit=1
            )

        url = fake.requests[0].full_url
        assert 'limit=1' in url
        assert 'status=SCORED%2CSCORING_ERROR' in url
        run = page.items[0]
        assert run.reward == 1
        assert run.metrics == {'f2p': 1.0}
        # Wire camelCase never reaches the user: typed ModelUsage + snake_case timings.
        # Spend is a FIRST-CLASS trial field now, not a modelUsage key — one
        # place per fact, and None means the trial never ran rather than zero.
        assert run.spent_usd == 0.93
        assert run.spend_source == 'measured'
        assert run.phase_timings_ms == {'agent_ms': 203000}
        # First-class run facts on list rows — same shape as the detail route
        assert run.sandbox_provider == 'daytona'
        assert run.verifier_mode == 'separate'
        assert run.resolved_harness_version == 'codex-cli 0.145.0'
        # Where the trial ran: the agent's box and the verifier's box
        assert run.sandbox_id == 'im8f0wgqwehvng70evvro'
        assert run.verifier_sandbox_id == 'iv2k1xbqwehvng70evvrp'
        assert run.session_ref == 'sess-9'

    @pytest.mark.asyncio
    async def test_cancel_and_rerun_failed(self):
        fake = FakeUrlopen([
            ('/cancel', {**RUN_SUMMARY, 'status': 'CANCELLING'}),
            ('/rerun-failed', {**RUN_SUMMARY, 'id': 'job-2', 'sourceJobId': 'job-1'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = jobs_factory(CONFIG)
            cancelled = await client.cancel('job-1')
            rerun = await client.rerun_failed('job-1', idempotency_key='idem-rr')

        assert cancelled.status == 'CANCELLING'
        assert fake.requests[0].get_method() == 'POST'
        assert rerun.id == 'job-2'
        assert rerun.source_job_id == 'job-1'
        assert fake.requests[1].get_header('Idempotency-key') == 'idem-rr'

    @pytest.mark.asyncio
    async def test_regrade_trial_job_and_read(self):
        result_wire = {
            'id': 'rr-1',
            'sourceTrialId': 'run-1',
            'taskKey': 'demo-task',
            'status': 'SCORED',
            'reward': 0.5,
            'metrics': {'f2p': 0.5},
            'sourceReward': 1,
            'sourceStatus': 'SCORED',
            'rewardDelta': -0.5,
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
            'id': 'rj-1',
            'sourceJobId': 'job-1',
            'status': 'COMPLETED',
            'sandboxProvider': 'e2b',
            'filter': {'taskKey': 'demo-task'},
            'createdAt': '2026-07-24T00:00:00Z',
            'updatedAt': '2026-07-24T00:05:00Z',
            # ONE key named for the collection: the whole-job tally plus this
            # page of results, with every regrade status named.
            'results': {
                'total': 1,
                'byStatus': {
                    'QUEUED': 0, 'RUNNING': 0, 'SCORED': 1,
                    'SCORING_ERROR': 0, 'INFRASTRUCTURE_ERROR': 0, 'INDETERMINATE': 0,
                },
                'items': [result_wire],
                'nextCursor': None,
                'hasMore': False,
            },
        }

        def with_total(total):
            return {**job_wire, 'results': {**job_wire['results'], 'total': total}}

        fake = FakeUrlopen([
            ('/trials/run-1/regrade', with_total(1)),
            ('/job-1/regrade', with_total(2)),
            ('/api/regrades/rj-1', job_wire),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = jobs_factory(CONFIG)
            per_run = await client.regrade_trial('job-1', 'run-1')
            per_job = await client.regrade('job-1', status=['SCORED'], task_key='demo-task')
            read = await client.get_regrade('rj-1')

        # Per-run regrade: POST the per-run route, one queued result.
        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/trials/run-1/regrade')
        assert per_run.id == 'rj-1'
        assert per_run.source_job_id == 'job-1'
        assert per_run.results.total == 1
        assert per_run.results.by_status['INDETERMINATE'] == 0

        # Per-job regrade: POST the filter body.
        assert fake.requests[1].get_method() == 'POST'
        sent = json.loads(fake.requests[1].data.decode('utf-8'))
        assert sent == {'status': ['SCORED'], 'taskKey': 'demo-task'}
        assert per_job.results.total == 2

        # Read: results mapped with immutable source snapshots + delta + lineage.
        assert read.status == 'COMPLETED'
        assert read.filter.task_key == 'demo-task'
        assert len(read.results.items) == 1
        assert read.results.next_cursor is None
        assert read.results.has_more is False
        result = read.results.items[0]
        assert result.task_key == 'demo-task'
        assert result.source_reward == 1
        assert result.reward_delta == -0.5
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
                await jobs_factory(CONFIG).regrade_trial('job-1', 'run-1')
        assert exc.value.status == 409
        assert exc.value.code == 'regrade_source_ineligible'

    @pytest.mark.asyncio
    async def test_export_bytes_and_streamed_file(self, tmp_path):
        archive = gzip.compress(json.dumps({'job': {'id': 'job-1'}}).encode('utf-8'))
        fake = FakeUrlopen([
            ('/export', archive, {'Content-Disposition': 'attachment; filename="job-job-1-export.json.gz"'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = jobs_factory(CONFIG)
            payload = await client.export('job-1')
            path = await client.export('job-1', to=str(tmp_path))

        assert payload == archive
        assert path.endswith('job-job-1-export.json.gz')
        with open(path, 'rb') as f:
            assert f.read() == archive

    @pytest.mark.asyncio
    async def test_download_package_bytes_and_streamed_file(self, tmp_path):
        """The OWNER-ONLY corpus retrieval: bytes, or straight to a directory."""
        package = gzip.compress(b'corpus bytes')
        digest = hashlib.sha256(package).hexdigest()
        fake = FakeUrlopen([
            (
                '/package',
                package,
                {
                    'Content-Disposition': 'attachment; filename="acme@1.1-corpus.tar.gz"',
                    'x-package-sha256': digest,
                },
            ),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            client = benchmarks_factory(CONFIG)
            payload = await client.download_package('imp-1')
            path = await client.download_package('imp-1', to=str(tmp_path))

        assert payload == package
        with open(path, 'rb') as f:
            assert f.read() == package
        assert '/api/benchmarks/imports/imp-1/package' in fake.requests[0].full_url

    @pytest.mark.asyncio
    async def test_download_package_refuses_a_backslash_filename(self, tmp_path):
        """PARITY: refused, not repaired.

        This used to translate the backslash to a separator and save
        ``b.tar.gz`` while the TypeScript SDK fell back to its own name — one
        response, two files. Refusing is the half that was kept: on POSIX
        ``a\\b.tar.gz`` is ONE legal filename, so treating the backslash as a
        separator renames the user's file on a guess about which platform wrote
        the header.
        """
        package = gzip.compress(b'corpus bytes')
        fake = FakeUrlopen([
            (
                '/package',
                package,
                {
                    'Content-Disposition': 'attachment; filename="a\\b.tar.gz"',
                    'x-package-sha256': hashlib.sha256(package).hexdigest(),
                },
            ),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            path = await benchmarks_factory(CONFIG).download_package(
                'imp-bs', to=str(tmp_path)
            )

        assert os.path.basename(path) == 'import-imp-bs-corpus.tar.gz'
        with open(path, 'rb') as f:
            assert f.read() == package

    @pytest.mark.asyncio
    async def test_two_concurrent_downloads_into_one_directory_both_succeed(self, tmp_path):
        """The scratch file is per call, so neither download is the other's.

        With ``<file>.part`` verbatim the two calls wrote into ONE file and the
        loser died on a bare ENOENT from os.replace — and the digest each had
        checked described its own stream rather than the bytes that landed.
        """
        package = gzip.compress(b'corpus bytes for the race')
        headers = {
            'Content-Disposition': 'attachment; filename="acme@1.1-corpus.tar.gz"',
            'Content-Length': str(len(package)),
            'x-package-sha256': hashlib.sha256(package).hexdigest(),
        }
        with patch(
            'evolve.hosted.urllib.request.urlopen',
            FakeUrlopen([('/package', package, headers)]),
        ):
            client = benchmarks_factory(CONFIG)
            first, second = await asyncio.gather(
                client.download_package('imp-race', to=str(tmp_path)),
                client.download_package('imp-race', to=str(tmp_path)),
            )

        assert first == second
        with open(first, 'rb') as f:
            assert f.read() == package
        # No scratch file survives either call.
        assert [p.name for p in tmp_path.iterdir()] == ['acme@1.1-corpus.tar.gz']

    @pytest.mark.asyncio
    async def test_download_package_refuses_bytes_failing_the_stated_digest(self, tmp_path):
        """The server hashes before sending; the client closes the wire half."""
        package = gzip.compress(b'corpus bytes')
        headers = {
            'Content-Disposition': 'attachment; filename="acme@1.1-corpus.tar.gz"',
            'x-package-sha256': 'f' * 64,  # not the bytes above
        }
        with patch(
            'evolve.hosted.urllib.request.urlopen',
            FakeUrlopen([('/package', package, headers)]),
        ):
            with pytest.raises(EvolveDigestMismatchError):
                await benchmarks_factory(CONFIG).download_package('imp-bad')

        with patch(
            'evolve.hosted.urllib.request.urlopen',
            FakeUrlopen([('/package', package, headers)]),
        ):
            with pytest.raises(EvolveDigestMismatchError):
                await benchmarks_factory(CONFIG).download_package(
                    'imp-bad', to=str(tmp_path)
                )
        # A file that does not match its digest looks like the corpus and is
        # not, so it must not survive the failure.
        assert list(tmp_path.iterdir()) == []

    @pytest.mark.asyncio
    async def test_download_package_refuses_a_truncated_body(self, tmp_path):
        """A socket cut mid-body is a normal end of stream to urllib.

        copyfileobj therefore returned a PARTIAL file as success. Content-Length
        is the server's own count, and disagreeing with it is the only signal
        that the body did not all arrive.
        """
        package = gzip.compress(b'corpus bytes')
        headers = {
            'Content-Disposition': 'attachment; filename="acme@1.1-corpus.tar.gz"',
            'Content-Length': str(len(package) + 1000),  # promised more than sent
            'x-package-sha256': hashlib.sha256(package).hexdigest(),
        }
        with patch(
            'evolve.hosted.urllib.request.urlopen',
            FakeUrlopen([('/package', package, headers)]),
        ):
            with pytest.raises(EvolveIncompleteDownloadError):
                await benchmarks_factory(CONFIG).download_package('imp-short')

        with patch(
            'evolve.hosted.urllib.request.urlopen',
            FakeUrlopen([('/package', package, headers)]),
        ):
            with pytest.raises(EvolveIncompleteDownloadError):
                await benchmarks_factory(CONFIG).download_package(
                    'imp-short', to=str(tmp_path)
                )
        # Neither the final path nor the .part temp survives.
        assert list(tmp_path.iterdir()) == []

    @pytest.mark.asyncio
    async def test_download_package_refuses_a_traversing_filename(self, tmp_path):
        """The filename interpolates a user-supplied version label."""
        package = gzip.compress(b'corpus bytes')
        inner = tmp_path / 'inner'
        headers = {
            'Content-Disposition': 'attachment; filename="../../escaped.tar.gz"',
            'Content-Length': str(len(package)),
            'x-package-sha256': hashlib.sha256(package).hexdigest(),
        }
        with patch(
            'evolve.hosted.urllib.request.urlopen',
            FakeUrlopen([('/package', package, headers)]),
        ):
            path = await benchmarks_factory(CONFIG).download_package(
                'imp-esc', to=str(inner)
            )

        assert path.startswith(str(inner))
        assert '..' not in path
        assert not (tmp_path / 'escaped.tar.gz').exists()

    @pytest.mark.asyncio
    async def test_download_package_not_retained_is_distinguishable(self):
        """A pre-retention version answers its own code, not import_not_found."""
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'package_not_retained',
                    'message': 'No original package is stored for import imp-old.',
                }}).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await benchmarks_factory(CONFIG).download_package('imp-old')
        assert exc.value.status == 404
        assert exc.value.code == 'package_not_retained'

    @pytest.mark.asyncio
    async def test_export_rejects_unknown_format(self):
        with pytest.raises(ValueError, match='harbor'):
            await jobs_factory(CONFIG).export('job-1', format='zip')

    # ------------------------------------------------------------------ watch

    @pytest.mark.asyncio
    async def test_watch_streams_events_to_terminal(self):
        stream = sse_text([
            {'seq': 0, 'type': 'job.created', 'data': {'trialCount': 2}},
            {'seq': 1, 'type': 'trial.settled', 'data': {'trialId': 'run-1', 'status': 'SCORED', 'reward': 1}},
        ]) + ': heartbeat\n\n' + sse_text([
            {'seq': 2, 'type': 'job.completed', 'data': {'scored': 2}},
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
            final = await jobs_factory(CONFIG).watch(
                'job-1', on_event=lambda e: events.append(e)
            )

        assert [e.seq for e in events] == [0, 1, 2]
        assert events[0].type == 'job.created'
        assert events[0].data == {'trialCount': 2}
        assert events[2].type == 'job.completed'
        assert final.status == 'COMPLETED'
        stream_request = next(r for r in fake.requests if '/events' in r.full_url)
        assert stream_request.get_header('Accept') == 'text/event-stream'
        assert stream_request.get_header('Last-event-id') is None

    @pytest.mark.asyncio
    async def test_watch_iter_yields_events_until_terminal(self):
        stream = sse_text([
            {'seq': 0, 'type': 'job.created', 'data': {}},
            {'seq': 1, 'type': 'job.completed', 'data': {}},
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
            async for event in jobs_factory(CONFIG).watch_iter('job-1'):
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
                            {'seq': 0, 'type': 'job.created', 'data': {}},
                            {'seq': 1, 'type': 'trial.running', 'data': {'trialId': 'run-1'}},
                        ]).encode('utf-8'))
                    return FakeSseResponse(sse_text([
                        {'seq': 2, 'type': 'job.completed', 'data': {}},
                    ]).encode('utf-8'))
                status = 'COMPLETED' if connects['count'] >= 2 else 'RUNNING'
                return FakeResponse({**RUN_SUMMARY, 'status': status})

        fake = ReconnectUrlopen([])
        events = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            final = await jobs_factory(CONFIG).watch(
                'job-1', on_event=lambda e: events.append(e), reconnect_delay_s=0.001
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
                        {'seq': 0, 'type': 'job.created', 'data': {}},
                    ]).encode('utf-8') if connects['count'] == 1 else b'')
                return FakeResponse({**RUN_SUMMARY, 'status': 'CANCELLED'})

        fake = QuietCloseUrlopen([])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            final = await jobs_factory(CONFIG).watch('job-1', reconnect_delay_s=0.001)

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
                await jobs_factory(CONFIG).watch(
                    'job-1', reconnect_delay_s=0.001, timeout_s=0.05
                )

    @pytest.mark.asyncio
    async def test_watch_raises_typed_error_on_404(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({
                    'error': {'code': 'job_not_found', 'message': 'Job not found: job-x'},
                }).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await jobs_factory(CONFIG).watch('job-x')
        assert exc_info.value.status == 404
        assert exc_info.value.code == 'job_not_found'
        assert 'Job not found: job-x' in str(exc_info.value)

    # ---------------------------------------------------------------- shapes

    @pytest.mark.asyncio
    async def test_run_posts_per_trial_cap(self):
        fake = FakeUrlopen([
            ('/api/jobs', {**RUN_SUMMARY, 'maxTrialSpendUsd': 2, 'worstCaseSpendUsd': 10}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
                max_trial_spend_usd=2,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['maxTrialSpendUsd'] == 2
        assert list(body) == ['benchmark', 'agents', 'maxTrialSpendUsd']
        assert job.max_trial_spend_usd == 2
        # The cap alone does not say what the JOB can cost; the server does.
        assert job.worst_case_spend_usd == 10

    @pytest.mark.asyncio
    async def test_run_omits_absent_spend_cap(self):
        # max_trial_spend_usd is optional: the server applies its own default
        # ($200 per trial, operator-tunable) and the response echoes the
        # RESOLVED cap plus the worst case it implies for this job.
        fake = FakeUrlopen([
            ('/api/jobs', {**RUN_SUMMARY, 'maxTrialSpendUsd': 200, 'worstCaseSpendUsd': 1000}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # ABSENT, never None: an explicit null would defeat the server-side
        # default the omission is asking for.
        assert 'maxTrialSpendUsd' not in body
        assert body == {
            'benchmark': 'deep-swe@1.1',
            'agents': [{'harness': 'codex', 'model': 'gpt-5.5'}],
        }
        assert job.max_trial_spend_usd == 200
        assert job.worst_case_spend_usd == 1000

    @pytest.mark.asyncio
    async def test_run_forwards_stated_spend_cap(self):
        fake = FakeUrlopen([('/api/jobs', RUN_SUMMARY)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
                max_trial_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['maxTrialSpendUsd'] == 25
        assert list(body) == ['benchmark', 'agents', 'maxTrialSpendUsd']

    @pytest.mark.asyncio
    async def test_run_posts_sandbox_provider(self):
        fake = FakeUrlopen([
            ('/api/jobs', {**RUN_SUMMARY, 'sandboxProvider': 'daytona'}),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            job = await jobs_factory(CONFIG).run(
                benchmark='deep-swe@1.1',
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
                max_trial_spend_usd=25,
                sandbox_provider='daytona',
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['sandboxProvider'] == 'daytona'
        assert job.sandbox_provider == 'daytona'

    @pytest.mark.asyncio
    async def test_trial_detail_mapping(self):
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials/run-1', {
                'id': 'run-1',
                'jobId': 'job-1',
                'taskKey': 'abs-module-cache-flags',
                'agent': {'harness': 'codex', 'model': 'gpt-5.5', 'harnessVersion': None},
                'runNumber': 1,
                'status': 'SCORED',
                'reward': 1,
                'metrics': {'f2p': 1.0},
                'failurePhase': None,
                'failureDetail': None,
                'phaseTimingsMs': {'agentMs': 203000, 'verifyMs': 41000},
                'modelUsage': {
                    'maxTrialSpendUsd': 2,
                    'inputTokens': 1234,
                },
                'spentUsd': 0.93,
                'spendSource': 'measured',
                'sandboxProvider': 'e2b',
                'verifierMode': 'shared',
                'resolvedHarnessVersion': '0.29.0',
                'sandboxId': 'im8f0wgqwehvng70evvro',
                'sessionRef': 'sess-9',
                'createdAt': '2026-07-22T00:00:00.000Z',
                'updatedAt': '2026-07-22T00:04:00.000Z',
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            run = await jobs_factory(CONFIG).trial('job-1', 'run-1')

        assert '/api/jobs/job-1/trials/run-1' in fake.requests[0].full_url
        assert run.job_id == 'job-1'
        assert run.resolved_harness_version == '0.29.0'
        assert run.sandbox_provider == 'e2b'
        assert run.verifier_mode == 'shared'
        assert run.sandbox_id == 'im8f0wgqwehvng70evvro'
        # Absent on the wire (shared mode boots no second box; old servers
        # omit the field entirely) — stays None, never a KeyError.
        assert run.verifier_sandbox_id is None
        assert run.phase_timings_ms == {'agent_ms': 203000, 'verify_ms': 41000}
        # Spend is FIRST-CLASS on the trial, not a key of the blob: one place
        # per fact, and None would mean "never ran" rather than zero.
        assert run.spent_usd == 0.93
        assert run.spend_source == 'measured'
        usage = run.model_usage
        # The one spend-adjacent key that stays in the blob is the CAP, which is
        # history (the cap THIS trial's key carried), not a queryable dimension.
        assert usage.max_trial_spend_usd == 2
        # Unknown harness-specific keys land in extra, snake_cased
        assert usage.extra == {'input_tokens': 1234}
        assert run.session_ref == 'sess-9'
        assert run.reward == 1

    @pytest.mark.asyncio
    async def test_trial_trace_paging(self):
        fake = FakeUrlopen([
            ('/trace', {
                'items': [
                    {'seq': 3, 'type': 'agent.message', 'data': {'text': 'hi'}},
                    {'seq': 4, 'type': 'tool.call', 'data': {}},
                ],
                'nextCursor': '4',
                'hasMore': True,
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            page = await jobs_factory(CONFIG).trial_trace(
                'job-1', 'run-1', cursor='2', limit=500,
            )

        url = fake.requests[0].full_url
        assert '/api/jobs/job-1/trials/run-1/trace' in url
        assert 'cursor=2' in url and 'limit=500' in url
        assert [e.seq for e in page.items] == [3, 4]
        assert page.items[0].type == 'agent.message'
        assert page.next_cursor == '4'
        assert page.has_more is True

    @pytest.mark.asyncio
    async def test_trial_artifact_selectors(self):
        fake = FakeUrlopen([
            ('stream=trace-stdout', {'log': 'raw harness stdout'}),
            ('stream=agent-home', {'files': {'/root/.claude/history.jsonl': '{}'}}),
            ('stream=verifier', {'log': None}),
        ])
        client = jobs_factory(CONFIG)
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            log = await client.trial_artifact('job-1', 'run-1', 'trace-stdout')
            home = await client.trial_artifact('job-1', 'run-1', 'agent-home')
            grader = await client.trial_artifact('job-1', 'run-1', 'verifier')

        assert (
            '/api/jobs/job-1/trials/run-1/trace?stream=trace-stdout'
            in fake.requests[0].full_url
        )
        # Log selectors answer the text; agent-home answers path -> text.
        assert log == 'raw harness stdout'
        assert home == {'/root/.claude/history.jsonl': '{}'}
        # Never stored is a normal answer, not an error.
        assert grader is None
        # The signature says so too: the return annotation is the nullable
        # union (str | Dict[str, str] | None), not just the stored shapes.
        hints = typing.get_type_hints(client.trial_artifact)
        assert typing.get_args(hints['return']) == (str, Dict[str, str], type(None))

    @pytest.mark.asyncio
    async def test_trial_trace_events_drains_pages(self):
        pages = {
            None: {
                'items': [{'seq': 1, 'type': 'a', 'data': {}}, {'seq': 2, 'type': 'b', 'data': {}}],
                'nextCursor': '2',
                'hasMore': True,
            },
            # nextCursor null MEANS CAUGHT UP — it never echoes the position
            # back, so the drain needs no extra empty-page request to learn it.
            '2': {'items': [{'seq': 3, 'type': 'c', 'data': {}}], 'nextCursor': None, 'hasMore': False},
        }

        class PagedUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                url = request.full_url
                query = urllib_parse.parse_qs(urllib_parse.urlsplit(url).query)
                cursor = query.get('cursor', [None])[0]
                return FakeResponse(pages[cursor])

        fake = PagedUrlopen([])
        seqs = []
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            async for event in jobs_factory(CONFIG).trial_trace_events(
                'job-1', 'run-1'
            ):
                seqs.append(event.seq)

        assert seqs == [1, 2, 3]
        cursors = [
            urllib_parse.parse_qs(urllib_parse.urlsplit(r.full_url).query).get('cursor', [None])[0]
            for r in fake.requests
        ]
        assert cursors == [None, '2']

    @pytest.mark.asyncio
    async def test_compare_drops_internal_agent_fields(self):
        fake = FakeUrlopen([
            ('/api/jobs/compare', {
                'jobs': [
                    {
                        'id': 'job-1',
                        'benchmark': 'deep-swe@1.1',
                        'status': 'COMPLETED',
                        'meanReward': 0.0,  # zero is a reward, never nulled
                        'coverage': {'scored': 5, 'total': 5},
                        'spentUsd': 3.2,
                        'agents': [
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
                        'id': 'job-2',
                        'benchmark': 'deep-swe@1.1',
                        'status': 'COMPLETED',
                        'meanReward': None,
                        'coverage': {'scored': 0, 'total': 5},
                        'spentUsd': 1.0,
                        'agents': [],
                        'createdAt': '2026-07-22T01:00:00.000Z',
                    },
                ],
                'taskMatrix': [],
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            comparison = await jobs_factory(CONFIG).compare(['job-1', 'job-2'])

        agent = comparison.jobs[0].agents[0]
        assert (agent.harness, agent.model, agent.harness_version) == ('codex', 'gpt-5.5', None)
        assert not hasattr(agent, 'id')
        assert not hasattr(agent, 'system_digest')
        assert comparison.jobs[0].mean_reward == 0.0
        assert comparison.jobs[1].mean_reward is None

    @pytest.mark.asyncio
    async def test_compare_maps_aggregates_and_matrix(self):
        fake = FakeUrlopen([
            ('/api/jobs/compare', {
                'jobs': [
                    {
                        'id': 'job-1',
                        'benchmark': 'deep-swe@1.1',
                        'status': 'COMPLETED',
                        'meanReward': 0.62,
                        'coverage': {'scored': 100, 'total': 113},
                        'spentUsd': 21.4,
                        'agents': [{'harness': 'codex', 'model': 'gpt-5.5'}],
                        'createdAt': '2026-07-22T00:00:00.000Z',
                    },
                ],
                'taskMatrix': [
                    {
                        'taskKey': 'abs-module-cache-flags',
                        'disagreement': True,
                        'cells': [
                            {
                                'jobId': 'job-1',
                                'status': 'SCORED',
                                'meanReward': 1,
                                'coverage': {'scored': 1, 'total': 1},
                            },
                            {
                                'jobId': 'job-2',
                                'status': 'MISSING',
                                'meanReward': None,
                                'coverage': {'scored': 0, 'total': 0},
                            },
                        ],
                    },
                ],
            }),
        ])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            comparison = await jobs_factory(CONFIG).compare(['job-1', 'job-2'])

        assert 'ids=job-1,job-2' in fake.requests[0].full_url
        aggregate = comparison.jobs[0]
        assert aggregate.mean_reward == 0.62
        assert (aggregate.coverage.scored, aggregate.coverage.total) == (100, 113)
        assert aggregate.agents[0].harness == 'codex'
        row = comparison.task_matrix[0]
        assert row.disagreement is True
        # Same statistic, same name, at every level of the compare payload
        assert row.cells[0].mean_reward == 1
        assert row.cells[1].status == 'MISSING'
        assert row.cells[1].mean_reward is None

    @pytest.mark.asyncio
    async def test_export_harbor_format(self):
        archive = gzip.compress(b'{}')
        fake = FakeUrlopen([('/export', archive)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            payload = await jobs_factory(CONFIG).export('job-1', format='harbor')

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
                        'code': 'job_not_terminal',
                        'message': 'Job is RUNNING; export requires a terminal job',
                    },
                }).encode('utf-8')),
            )

        with patch('evolve.hosted.urllib.request.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await jobs_factory(CONFIG).export('job-1')
        error = exc_info.value
        assert error.status == 409
        assert error.code == 'job_not_terminal'
        # The message is the clean product sentence — no JSON, no status prefix
        assert str(error) == 'Job is RUNNING; export requires a terminal job'

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
                await jobs_factory(CONFIG).get('job-1')
        assert exc_info.value.status == 502
        assert exc_info.value.code == 'unknown_error'
