"""checks() — Harbor's ``harbor check <PATH>`` as the hosted client
(``POST /api/checks``, ``GET /api/checks``, ``GET /api/checks/{checkId}``):
the directory is packed to a temp file and streamed as the ``archive`` part
BEHIND the ``config`` part (so the server rules the policy before a byte of
the upload), the archive is named by the directory (Harbor's task_name for
a single-task upload), the 202 maps to the Check verbatim, the reads ride
the contract's two GETs, and ``watch()`` polls to ``completed`` with the
analysis watch's backoff shape. Mocked urlopen, real tar bytes.
"""

import inspect
import json
from unittest.mock import patch

import pytest

from evolve import (
    EvolveAPIError,
    HostedClientConfig,
    checks as checks_factory,
    hosted,
)
from tests.unit.test_hosted_client_api import FakeUrlopen, _multipart_parts

CONFIG = HostedClientConfig(api_key='test-key', base_url='http://localhost:3000')

TASK_CHECK = {
    'id': 'tc-1',
    'check_id': 'chk-1',
    'task_name': 'hello-world',
    'status': 'queued',
    'checks': None,
    'cost_usd': None,
    'attempts': 1,
    'failure': None,
    'created_at': '2026-09-09T10:00:00.000Z',
    'finished_at': None,
}

CHECK_ACCEPTED = {
    'id': 'chk-1',
    'status': 'queued',
    'source': {'type': 'archive', 'sha256': 'ab' * 32, 'bytes': 1234},
    'model_name': 'glm-5.3-flash',
    'reasoning_effort': 'max',
    'rubric': {'criteria': [{'name': 'typos', 'description': 'd', 'guidance': 'g'}]},
    'prompt': None,
    'sandbox_provider': 'daytona',
    'n_concurrent': None,
    'include_task_names': [],
    'exclude_task_names': [],
    'n_tasks': None,
    'results': [TASK_CHECK],
    'cost_usd': None,
    'created_at': '2026-09-09T10:00:00.000Z',
    'finished_at': None,
}

CHECK_DONE = {
    **CHECK_ACCEPTED,
    'status': 'completed',
    'results': [
        {
            **TASK_CHECK,
            'status': 'completed',
            'checks': {'typos': {'outcome': 'pass', 'explanation': 'none found'}},
            'cost_usd': 0.0123,
            'finished_at': '2026-09-09T10:05:00.000Z',
        }
    ],
    'cost_usd': 0.0123,
    'finished_at': '2026-09-09T10:05:00.000Z',
}


def _write_task_dir(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'task.toml').write_text('schema_version = "1.4"\n')
    (root / 'instruction.md').write_text('Print hello.\n')
    (root / 'environment').mkdir()
    (root / 'environment' / 'Dockerfile').write_text('FROM python:3.13-slim\n')
    (root / 'tests').mkdir()
    (root / 'tests' / 'test.sh').write_text('echo 1\n')


class TestChecksCreate:
    @pytest.mark.asyncio
    async def test_create_packs_the_directory_and_sends_the_config_part_first(self, tmp_path):
        from evolve.hosted import _tar_gzip_directory_to_file

        task_dir = tmp_path / 'hello-world'
        _write_task_dir(task_dir)
        fake = FakeUrlopen([('/api/checks', CHECK_ACCEPTED, {}, 202)])
        progress = []
        with patch('evolve._http.urlopen', fake):
            accepted = await checks_factory(CONFIG).create(
                str(task_dir),
                model_name='glm-5.3',
                include_task_names=['hello-*'],
                n_tasks=3,
                on_upload_progress=lambda sent, total: progress.append((sent, total)),
            )

        request = fake.requests[0]
        assert request.full_url.endswith('/api/checks')
        assert request.get_method() == 'POST'
        parts = _multipart_parts(request)
        # The policy travels FIRST as one JSON part, then the archive — the
        # server refuses a bad policy before receiving the upload.
        assert list(parts) == ['config', 'archive']
        assert json.loads(parts['config'].decode('utf-8')) == {
            'model_name': 'glm-5.3',
            'include_task_names': ['hello-*'],
            'n_tasks': 3,
        }
        assert parts['archive'][:2] == b'\x1f\x8b'
        reference = tmp_path / 'reference.tar.gz'
        _tar_gzip_directory_to_file(str(task_dir), str(reference))
        assert parts['archive'] == reference.read_bytes()
        # The archive part is NAMED by the directory: Harbor's task_name for
        # a single-task upload rides the filename.
        body = request.data if isinstance(request.data, bytes) else b''.join(request.data)
        assert b'filename="hello-world.tar.gz"' in body
        assert progress and progress[-1][0] == progress[-1][1]
        assert accepted['id'] == 'chk-1'
        assert accepted['status'] == 'queued'
        assert accepted['results'][0]['task_name'] == 'hello-world'
        assert accepted['source'] == {'type': 'archive', 'sha256': 'ab' * 32, 'bytes': 1234}

    @pytest.mark.asyncio
    async def test_create_defaults_send_the_empty_config(self, tmp_path):
        task_dir = tmp_path / 'hello-world'
        _write_task_dir(task_dir)
        fake = FakeUrlopen([('/api/checks', CHECK_ACCEPTED, {}, 202)])
        with patch('evolve._http.urlopen', fake):
            await checks_factory(CONFIG).create(str(task_dir))
        parts = _multipart_parts(fake.requests[0])
        assert json.loads(parts['config'].decode('utf-8')) == {}

    @pytest.mark.asyncio
    async def test_create_refuses_at_the_keyboard(self, tmp_path):
        from evolve.hosted import _tar_gzip_directory_to_file

        client = checks_factory(CONFIG)
        # Harbor's own first refusal (checker.py:66-67), before any tar.
        with pytest.raises(ValueError, match="Path './nope' does not exist"):
            await client.create('./nope')
        # A directory only, as Harbor's PATH is (checker.py:125-130): a
        # ready-packed archive is a file, refused before any byte moves.
        task_dir = tmp_path / 'hello-world'
        _write_task_dir(task_dir)
        archive = tmp_path / 'hello-world.tar.gz'
        _tar_gzip_directory_to_file(str(task_dir), str(archive))
        with pytest.raises(ValueError, match='is not a directory'):
            await client.create(str(archive))
        assert 'archive_path' not in inspect.signature(client.create).parameters

    @pytest.mark.asyncio
    async def test_no_checkable_tasks_is_a_typed_error(self, tmp_path):
        empty = tmp_path / 'empty'
        empty.mkdir()
        (empty / 'README.md').write_text('nothing\n')
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 400, 'Bad Request', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'no_checkable_tasks',
                    'message': 'No valid task directories found in the archive',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await checks_factory(CONFIG).create(str(empty))
        assert exc.value.status == 400
        assert exc.value.code == 'no_checkable_tasks'


class TestChecksRead:
    @pytest.mark.asyncio
    async def test_get_reads_the_report(self):
        fake = FakeUrlopen([('/api/checks/chk-1', CHECK_DONE)])
        with patch('evolve._http.urlopen', fake):
            check = await checks_factory(CONFIG).get('chk-1')
        assert fake.requests[0].full_url.endswith('/api/checks/chk-1')
        assert check['status'] == 'completed'
        assert check['results'][0]['checks'] == {'typos': {'outcome': 'pass', 'explanation': 'none found'}}
        assert check['cost_usd'] == 0.0123

    @pytest.mark.asyncio
    async def test_list_rides_scope_and_status_on_the_query(self):
        fake = FakeUrlopen([('/api/checks', {'items': [CHECK_DONE], 'nextCursor': None, 'hasMore': False})])
        with patch('evolve._http.urlopen', fake):
            page = await checks_factory(CONFIG).list(scope='shared', status=['running', 'completed'], limit=5)
        url = fake.requests[0].full_url
        assert '/api/checks?' in url
        assert 'scope=shared' in url and 'status=running%2Ccompleted' in url and 'limit=5' in url
        assert page.items[0]['id'] == 'chk-1'
        assert page.next_cursor is None and page.has_more is False

    @pytest.mark.asyncio
    async def test_watch_polls_to_completed_and_reports_progress(self):
        fake = FakeUrlopen([('/api/checks/chk-1', CHECK_ACCEPTED)])
        seen = []
        # The first read is the queued record; flip the fake's answer to the
        # settled one after it, so the poll observes exactly one change.
        original = fake.__call__

        def answer(request, timeout=None):
            response = original(request, timeout)
            fake.responses = [('/api/checks/chk-1', CHECK_DONE)]
            return response

        with patch('evolve._http.urlopen', answer):
            final = await checks_factory(CONFIG).watch(
                'chk-1', poll_interval_s=0.01, on_progress=lambda c: seen.append(c['status'])
            )
        assert final['status'] == 'completed'
        assert seen == ['queued', 'completed']
        assert len(fake.requests) == 2

    def test_the_facade_exposes_checks(self):
        client = hosted(CONFIG)
        assert type(client.checks).__name__ == 'ChecksClient'
        assert client.checks is client.checks
