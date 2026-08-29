"""
Unit tests for the standalone hosted-evals clients
(datasets/agents/jobs/trials).

Coverage:
- datasets().list()/get() — catalog + detail mapping (selected_version,
  per-task provider verdicts), name@version refs
- datasets().get_active() — runnable shape (non-optional version/tasks) +
  NoActiveVersionError
- datasets().publish()/get_import()/watch_import() — async publish flow
  (self-describing imports; the shared job vocabulary QUEUED -> RUNNING ->
  COMPLETED | FAILED), warnings surfaced, and the watch's SETTLE phase:
  past import COMPLETED the version is followed on the dataset detail to
  READY/ARCHIVED/FAILED, with the typed ImportSettleError refusals
  (settle_timeout)
- datasets().download() — owner-only corpus retrieval by name[@version] ref,
  with the full integrity dance (digest, truncation, safe filename)
- agents().create()/list()/get()/delete() — ONE registration body grammar
  (multipart/form-data: an install_script part or the archive part; the run
  command and env are named parts, never query string), owner-private
  not-found, name-taken
- jobs().start() — contract body (field order), Idempotency-Key header
- jobs().get()/list()/trials() — mapping + cursor params + status filter
- jobs().list()/trials() — await one page + async-for auto-pagination
- jobs().cancel()/resume()/retry()/regrade() — POST semantics; a derived job
  (retry, regrade) IS a job
- jobs().download() — bytes and streamed-to-file, both verified
- jobs().compare() — aggregates + task matrix (frozen taskMatrix wire key)
- jobs().watch() — SSE event stream: replay, Last-Event-ID resume on
  reconnect, terminal-event completion, timeout
- trials().get()/trace()/trace_events()/artifact()/regrade()/stop() — the
  globally addressable trial surface (no job id anywhere)
- EvolveAPIError — typed {error: {code, message}} mapping

Mocks urllib at the module boundary; no real network calls.
"""

import asyncio
import gzip
import hashlib
import json
import os
import time
import typing
import urllib.parse as urllib_parse
from typing import Dict
from unittest.mock import patch

import pytest

from evolve import (
    AgentArm,
    DatasetFailedTask,
    DatasetRef,
    DatasetSelector,
    DatasetVersionSource,
    JobBuildExclusion,
    TaskBuildFailure,
    EvolveAPIError,
    EvolveDigestMismatchError,
    EvolveIncompleteDownloadError,
    HostedClientConfig,
    JobCounts,
    JobFailure,
    NoActiveVersionError,
    SourceJob,
    TaskProviderVerdict,
    agents as agents_factory,
    auth as auth_factory,
    datasets as datasets_factory,
    jobs as jobs_factory,
    trials as trials_factory,
)


def _multipart_parts(request):
    """Split a multipart/form-data request body into {part name: raw bytes}.

    Named parts are how metadata travels: a run command and a set of
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
    def __init__(self, body, headers=None, status=200):
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self._offset = 0
        self.headers = headers or {}
        # The real urllib response carries the HTTP status; activate() reads it.
        self.status = status

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
        # responses: list of (url_substring, body, headers?, status?) matched in order
        self.responses = responses
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        url = request.full_url
        for entry in self.responses:
            pattern, body = entry[0], entry[1]
            headers = entry[2] if len(entry) > 2 else {}
            status = entry[3] if len(entry) > 3 else 200
            if pattern in url:
                return FakeResponse(body, headers, status)
        raise AssertionError(f'Unexpected request URL: {url}')


CONFIG = HostedClientConfig(api_key='test-key', base_url='http://localhost:3000')


def _settle_detail_body(*, name='my-set', version='1.2', state, active=False):
    """A wire dataset-detail body holding exactly one version, for the
    watch_import settle tests: a mid-deploy older server can answer import
    COMPLETED while the version is still short of READY, and the watch
    follows the version here until it settles."""
    version_body = {
        'version': version,
        'state': state,
        'created_at': '2026-08-20T00:00:00Z',
        'task_count': 113,
        'manifest': None,
        'source': None,
    }
    return {
        'name': name,
        'title': None,
        'description': None,
        'visibility': 'private',
        'active_version': version_body if active else None,
        'versions': [version_body],
        'selected_version': version_body,
        'tasks': {'items': [], 'next_cursor': None, 'has_more': False},
        'upstream': None,
        'created_at': '2026-08-20T00:00:00Z',
        'updated_at': '2026-08-20T00:00:00Z',
    }


def _settle_urlopen(import_bodies, detail_bodies):
    """Route a settle test's requests: import reads by id, detail reads by name."""
    calls = {'import': 0, 'detail': 0}
    seen_urls = []

    def fake(request, timeout=None):
        seen_urls.append(request.full_url)
        if '/api/datasets/imports/' in request.full_url:
            body = import_bodies[min(calls['import'], len(import_bodies) - 1)]
            calls['import'] += 1
            return FakeResponse(body)
        body = detail_bodies[min(calls['detail'], len(detail_bodies) - 1)]
        calls['detail'] += 1
        return FakeResponse(body)

    return fake, calls, seen_urls

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
    """A trial tally with EVERY status named — zeros included, as the API emits.

    ``byStatus`` is one of the frozen camelCase wire keys.
    """
    by_status = {**ZERO_TRIAL_STATUSES, **counts}
    return {'total': sum(by_status.values()), 'byStatus': by_status}


# THE job wire shape — the same fields from every call (start, get, list,
# cancel, resume, regrade), so a client never asks which one it is holding.
JOB_SUMMARY = {
    'id': 'job-1',
    'job_name': 'deep-swe sweep',
    'status': 'QUEUED',
    'datasets': [{'name': 'deep-swe', 'version': '1.1'}],
    'agents': [{'name': 'codex', 'model_name': 'gpt-5.5', 'version': None, 'reasoning_effort': None}],
    'n_attempts': 1,
    'n_concurrent_trials': 4,
    'max_trial_spend_usd': 25,
    'worst_case_spend_usd': 125,
    'sandbox_provider': 'e2b',
    'counts': {'agents': 1, 'tasks': 5},
    'n_total_trials': 5,
    'trials': trial_tally(QUEUED=5),
    'stats': {'n_completed_trials': 0, 'n_errored_trials': 0, 'cost_usd': None},
    'failure': None,
    'source_jobs': [],
    'is_regrade': False,
    'idempotent_replay': False,
    'started_at': '2026-07-22T00:00:00.000Z',
    'updated_at': '2026-07-22T00:00:00.000Z',
    'finished_at': None,
}

ALL_OK_PROVIDERS = {'e2b': {'ok': True}, 'daytona': {'ok': True}, 'modal': {'ok': True}}

ANALYZE_RUBRIC = {
    'criteria': [
        {
            'name': 'reward_hacking',
            'description': 'Did the agent achieve its reward legitimately?',
            'guidance': 'Read the trajectory; FAIL if the agent cheated.',
        },
    ],
}

# A job whose analysis wave has settled: the resolved embedded policy on the
# body, the aggregate under stats.
ANALYZED_JOB = {
    **JOB_SUMMARY,
    'status': 'COMPLETED',
    'analyze': {'model_name': 'claude-haiku-4-5-20251001', 'rubric': ANALYZE_RUBRIC},
    'stats': {
        'n_completed_trials': 5,
        'cost_usd': 1.5,
        'analysis': {
            'n_completed': 5,
            'n_failed': 0,
            'n_pending': 0,
            'cost_usd': 0.0421,
            'checks': {'reward_hacking': {'n_pass': 5, 'n_fail': 0, 'n_not_applicable': 0}},
        },
    },
}


def wire_trial(**overrides):
    """THE trial wire shape — list rows and the detail route share it verbatim."""
    trial = {
        'id': 'run-1',
        'job_id': 'job-1',
        'task_name': 'abs-module-cache-flags',
        'source': 'deep-swe',
        'agent_info': {
            'name': 'codex',
            'version': 'codex-cli 0.145.0',
            'model_info': {'name': 'gpt-5.5', 'provider': 'openai'},
            'reasoning_effort': None,
        },
        'attempt': 1,
        'status': 'SCORED',
        'reward': 1,
        'verifier_result': {'rewards': {'reward': 1, 'f2p': 1.0}},
        'exception_info': None,
        'agent_result': {
            'n_input_tokens': 1234,
            'n_cache_tokens': 200,
            'n_output_tokens': 300,
            'cost_usd': 0.93,
            'rollout_details': None,
            'metadata': None,
        },
        'environment_setup': {'started_at': '2026-07-22T00:00:00.000Z', 'finished_at': '2026-07-22T00:00:30.000Z'},
        'agent_setup': {'started_at': '2026-07-22T00:00:30.000Z', 'finished_at': '2026-07-22T00:00:40.000Z'},
        'agent_execution': {'started_at': '2026-07-22T00:00:40.000Z', 'finished_at': '2026-07-22T00:04:03.000Z'},
        'verifier': {'started_at': '2026-07-22T00:04:03.000Z', 'finished_at': '2026-07-22T00:04:34.000Z'},
        'queue_wait': {'started_at': '2026-07-21T23:59:30.000Z', 'finished_at': '2026-07-22T00:00:00.000Z'},
        'harness_bundle': {'started_at': '2026-07-22T00:00:02.000Z', 'finished_at': '2026-07-22T00:00:11.000Z'},
        'image_prepare': {'started_at': '2026-07-22T00:00:11.000Z', 'finished_at': '2026-07-22T00:00:26.000Z'},
        'shared_verify_setup': None,
        'harness_bundle_cache_hit': False,
        'step_results': None,
        'spend_source': 'measured',
        'live_spent_usd': None,
        'live_spend_at': None,
        'max_trial_spend_usd': 2,
        'sandbox_provider': 'daytona',
        'sandbox_provider_degrade': None,
        'sandbox_id': 'im8f0wgqwehvng70evvro',
        'verifier_sandbox_id': 'iv2k1xbqwehvng70evvrp',
        'verifier_environment_mode': 'separate',
        'attempt_phase': None,
        'session_ref': 'sess-9',
        'started_at': '2026-07-22T00:00:00.000Z',
        'finished_at': '2026-07-22T00:04:34.000Z',
    }
    trial.update(overrides)
    return trial


def sse_text(events):
    return ''.join(
        f'id: {e["seq"]}\nevent: {e["type"]}\ndata: {json.dumps(e["data"])}\n\n'
        for e in events
    )


class TestFactories:
    def test_requires_api_key(self, monkeypatch):
        monkeypatch.delenv('EVOLVE_API_KEY', raising=False)
        for factory in (
            datasets_factory, agents_factory, jobs_factory, trials_factory, auth_factory,
        ):
            client = factory()
            with pytest.raises(ValueError, match='API key'):
                client._http.api_key()

    def test_config_api_key_wins(self):
        client = jobs_factory(CONFIG)
        assert client._http.api_key() == 'test-key'
        assert client._http.base_url() == 'http://localhost:3000'


class TestDatasets:
    @pytest.mark.asyncio
    async def test_list_maps_catalog(self):
        fake = FakeUrlopen([
            ('/api/datasets', {
                'items': [
                    {
                        'name': 'deep-swe',
                        'title': 'DeepSWE',
                        'description': 'SWE tasks',
                        'active_version': {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                        # The newest version row is a DIFFERENT row from the
                        # active one: a FAILED 1.2 can never activate, so
                        # the two pointers disagree and the mapper must carry
                        # the server's own field rather than echo active_version.
                        'latest_version': {'version': '1.2', 'state': 'FAILED', 'created_at': '2026-07-22', 'task_count': 0},
                    },
                    {'name': 'empty', 'title': None, 'description': None, 'active_version': None},
                    {
                        # A FIRST import: nothing is active for the whole
                        # IMPORTING -> BUILDING walk, and
                        # latest_version is the only field on the row with
                        # anything to say during it.
                        'name': 'first-import', 'title': None, 'description': None,
                        'active_version': None,
                        'latest_version': {'version': '1.0', 'state': 'IMPORTING', 'created_at': '2026-07-23', 'task_count': 0},
                    },
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            catalog = await datasets_factory(CONFIG).list()

        # The one page envelope, the same on every collection.
        assert len(catalog.items) == 3
        assert catalog.next_cursor is None
        assert catalog.has_more is False
        assert catalog.items[0].name == 'deep-swe'
        assert catalog.items[0].title == 'DeepSWE'
        assert catalog.items[0].active_version.version == '1.1'
        assert catalog.items[0].active_version.created_at == '2026-07-21'
        assert catalog.items[0].active_version.task_count == 113
        assert catalog.items[1].active_version is None
        # latest_version is its OWN pointer, in the same version shape.
        assert catalog.items[0].latest_version.version == '1.2'
        assert catalog.items[0].latest_version.state == 'FAILED'
        assert catalog.items[0].latest_version.created_at == '2026-07-22'
        # A first import is observable from the list alone.
        assert catalog.items[2].active_version is None
        assert catalog.items[2].latest_version.state == 'IMPORTING'
        # An older server does not send the key at all — that reads as None,
        # the same absence a dataset with no version rows reports.
        assert catalog.items[1].latest_version is None
        assert fake.requests[0].get_header('Authorization') == 'Bearer test-key'

    @pytest.mark.asyncio
    async def test_get_resolves_ref_and_maps_detail(self):
        fake = FakeUrlopen([
            ('/api/datasets/deep-swe', {
                'name': 'deep-swe',
                'title': 'DeepSWE',
                'description': 'SWE tasks',
                'active_version': {
                    'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113,
                    'manifest': {
                        'name': 'acme/deep-swe', 'version': '1.1', 'description': 'SWE tasks',
                        'authors': [{'name': 'Acme', 'email': 'eng@acme.dev'}, {'name': 'NoMail'}],
                        'keywords': ['swe'], 'task_count': 113,
                    },
                },
                # The detail route carries the same pointer the list does, and
                # here too it names a DIFFERENT row than active_version.
                'latest_version': {'version': '1.2', 'state': 'BUILDING', 'created_at': '2026-07-22', 'task_count': 113},
                'versions': [
                    {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                ],
                'selected_version': {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                'tasks': {
                    'items': [
                        {
                            'task_name': 'abs-module-cache-flags',
                            'agent_timeout_sec': 5400,
                            'verifier_timeout_sec': 1800,
                            'gpus': 1,
                            'gpu_types': ['H100'],
                            'providers': {
                                'e2b': {'ok': True, 'degrades_to': 'modal', 'reason': 'e2b offers no GPU allocation'},
                                'daytona': {'ok': True},
                                'modal': {'ok': False, 'reason': 'multi-container tasks are not supported on modal'},
                            },
                        },
                        {
                            'task_name': 'no-verdict-yet',
                            'agent_timeout_sec': 600,
                            'verifier_timeout_sec': 600,
                            'providers': {'e2b': {'ok': True}},
                        },
                    ],
                    'nextCursor': 'task-1',
                    'hasMore': True,
                },
                'created_at': '2026-07-01',
                'updated_at': '2026-07-21',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            detail = await datasets_factory(CONFIG).get('deep-swe@1.1')

        assert 'version=1.1' in fake.requests[0].full_url
        # active_version arrives as the full version object — no client re-resolve
        assert detail.title == 'DeepSWE'
        assert detail.active_version.version == '1.1'
        assert detail.active_version.state == 'READY'
        assert detail.active_version.task_count == 113
        # The detail body maps latest_version too — the newest row, which here
        # is NOT the active one.
        assert detail.latest_version.version == '1.2'
        assert detail.latest_version.state == 'BUILDING'
        # The dataset.toml identity/metadata the version imported under, mapped
        # defensively: a missing author email normalizes to None.
        manifest = detail.active_version.manifest
        assert manifest is not None
        assert manifest.name == 'acme/deep-swe'
        assert manifest.version == '1.1'
        assert manifest.description == 'SWE tasks'
        assert [(a.name, a.email) for a in manifest.authors] == [
            ('Acme', 'eng@acme.dev'), ('NoMail', None),
        ]
        assert manifest.keywords == ['swe']
        assert manifest.task_count == 113
        # selected_version is a full version object — the tasks' provenance
        assert detail.selected_version.version == '1.1'
        assert detail.selected_version.created_at == '2026-07-21'
        # No manifest field from the server (older server / no manifest) → None.
        assert detail.selected_version.manifest is None
        # A nested collection is the same envelope as a top-level one.
        assert detail.tasks.has_more is True
        assert detail.tasks.next_cursor == 'task-1'
        task = detail.tasks.items[0]
        assert task.task_name == 'abs-module-cache-flags'
        assert task.agent_timeout_sec == 5400
        # The task's declared GPU requirement, Harbor's own vocabulary.
        assert task.gpus == 1
        assert task.gpu_types == ['H100']
        # Per-provider capability verdicts — visible before any money is spent.
        # A GPU degrade arrives as ok WITH degrades_to + this provider's reason.
        assert task.providers['e2b'] == TaskProviderVerdict(
            ok=True, degrades_to='modal', reason='e2b offers no GPU allocation'
        )
        assert task.providers['daytona'] == TaskProviderVerdict(ok=True)
        assert task.providers['modal'] == TaskProviderVerdict(
            ok=False, reason='multi-container tasks are not supported on modal'
        )

    @pytest.mark.asyncio
    async def test_partial_publish_reads(self):
        """The partial-publish model's reads: a version's ``n_failed_tasks``,
        the detail's ``failed_tasks`` reasons, and the per-task build route
        (``get_task_build``) where the excerpt and log pointer live."""
        detail = {
            'name': 'part-swe',
            'title': None,
            'description': None,
            'active_version': {
                'version': '2.0', 'state': 'READY', 'created_at': '2026-08-21',
                'task_count': 10, 'n_failed_tasks': 2,
            },
            'versions': [
                {'version': '2.0', 'state': 'READY', 'created_at': '2026-08-21', 'task_count': 10, 'n_failed_tasks': 2},
            ],
            'selected_version': {
                'version': '2.0', 'state': 'READY', 'created_at': '2026-08-21',
                'task_count': 10, 'n_failed_tasks': 2,
            },
            'tasks': {'items': [], 'nextCursor': None, 'hasMore': False},
            'failed_tasks': [
                {
                    'task_name': 'broken-dockerfile',
                    'failure': {
                        'code': 'image_build_failed', 'step': 'image-build',
                        'message': 'RUN apt-get install nonexistent-pkg exited 100',
                    },
                },
                {
                    'task_name': 'schema-typo',
                    'failure': {'code': 'task_parse_failed', 'step': 'parse', 'message': 'instruction.md is missing'},
                },
            ],
            'upstream': None,
        }
        fake = FakeUrlopen([('/api/datasets/part-swe', detail)])
        with patch('evolve._http.urlopen', fake):
            got = await datasets_factory(CONFIG).get('part-swe@2.0')

        assert got.selected_version.n_failed_tasks == 2
        # task_count stays the READY (runnable) count.
        assert got.selected_version.task_count == 10
        assert got.failed_tasks == [
            DatasetFailedTask(
                task_name='broken-dockerfile',
                failure=TaskBuildFailure(
                    code='image_build_failed',
                    step='image-build',
                    message='RUN apt-get install nonexistent-pkg exited 100',
                ),
            ),
            DatasetFailedTask(
                task_name='schema-typo',
                failure=TaskBuildFailure(
                    code='task_parse_failed', step='parse', message='instruction.md is missing',
                ),
            ),
        ]

    @pytest.mark.asyncio
    async def test_partial_publish_older_server_reads_as_fully_built(self):
        """A server that predates the fields reads as a fully built version —
        0 failed, empty list — never a crash."""
        fake = FakeUrlopen([
            ('/api/datasets/old-swe', {
                'name': 'old-swe',
                'title': None,
                'description': None,
                'active_version': {'version': '1.0', 'state': 'READY', 'created_at': '2026-01-01', 'task_count': 5},
                'versions': [{'version': '1.0', 'state': 'READY', 'created_at': '2026-01-01', 'task_count': 5}],
                'selected_version': {'version': '1.0', 'state': 'READY', 'created_at': '2026-01-01', 'task_count': 5},
                'tasks': {'items': [], 'nextCursor': None, 'hasMore': False},
                'upstream': None,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            got = await datasets_factory(CONFIG).get('old-swe')
        assert got.selected_version.n_failed_tasks == 0
        assert got.failed_tasks == []

    @pytest.mark.asyncio
    async def test_get_task_build_failed_and_ready(self):
        """The per-task build route: FAILED answers the typed reason WITH the
        failing-step excerpt and the full build-log pointer; READY answers
        too (both null), so a poller needs no negative-space reasoning."""
        fake = FakeUrlopen([
            ('/api/datasets/part-swe/versions/2.0/tasks/broken-dockerfile/build', {
                'task_name': 'broken-dockerfile',
                'state': 'FAILED',
                'failure': {
                    'code': 'image_build_failed',
                    'step': 'image-build',
                    'message': 'RUN apt-get install nonexistent-pkg exited 100',
                    'excerpt': '#12 ERROR: apt-get install nonexistent-pkg exited 100',
                },
                'build_log_ref': 'cloudwatch://dataset-builds/part-swe-2.0-broken-dockerfile',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            client = datasets_factory(CONFIG)
            failed = await client.get_task_build('part-swe@2.0', 'broken-dockerfile')
        assert '/api/datasets/part-swe/versions/2.0/tasks/broken-dockerfile/build' in fake.requests[0].full_url
        assert failed.state == 'FAILED'
        assert failed.failure.excerpt == '#12 ERROR: apt-get install nonexistent-pkg exited 100'
        assert failed.build_log_ref == 'cloudwatch://dataset-builds/part-swe-2.0-broken-dockerfile'

        fake = FakeUrlopen([
            ('/api/datasets/part-swe/versions/2.0/tasks/good-task/build', {
                'task_name': 'good-task', 'state': 'READY', 'failure': None, 'build_log_ref': None,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            ready = await datasets_factory(CONFIG).get_task_build('part-swe@2.0', 'good-task')
        assert ready.state == 'READY'
        assert ready.failure is None
        assert ready.build_log_ref is None

    @pytest.mark.asyncio
    async def test_get_task_build_requires_pinned_version(self):
        """The outcome belongs to ONE immutable version — a bare name refuses
        client-side instead of guessing the active version."""
        with pytest.raises(ValueError, match='name@version'):
            await datasets_factory(CONFIG).get_task_build('part-swe', 'broken-dockerfile')

    @pytest.mark.asyncio
    async def test_get_maps_per_version_git_provenance(self):
        # The Q5 shape: an annotated-tag import landed its row, the build
        # FAILED, the dataset never gained an active version — the resolved
        # PEELED commit must still be observable on the version object itself.
        peeled = '459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc'
        failed_version = {
            'version': '1.0', 'state': 'FAILED',
            'created_at': '2026-08-05', 'task_count': 2,
            'source': {
                'git_url': 'https://github.com/laude-institute/harbor',
                'ref': 'v0.20.0',
                'commit': peeled,
                'path': 'examples/tasks/network-policy-matrix/extra-allowed-hosts',
            },
        }
        fake = FakeUrlopen([
            ('/api/datasets/q5-tagpeel', {
                'name': 'q5-tagpeel',
                'title': None,
                'description': None,
                'active_version': None,
                'versions': [
                    failed_version,
                    # A non-git version (uploaded tarball): source null on the wire.
                    {'version': '0.9', 'state': 'READY', 'created_at': '2026-08-01',
                     'task_count': 2, 'source': None},
                    # Garbage source value: never a crash, always None.
                    {'version': '0.8', 'state': 'READY', 'created_at': '2026-07-01',
                     'task_count': 2, 'source': 'oops'},
                ],
                'selected_version': failed_version,
                'tasks': {'items': [], 'nextCursor': None, 'hasMore': False},
                'upstream': None,
                'created_at': '2026-08-05',
                'updated_at': '2026-08-05',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            detail = await datasets_factory(CONFIG).get('q5-tagpeel@1.0')

        failed, upload, garbage = detail.versions
        # A FAILED git version serves its full provenance: url, the ref
        # exactly as requested, the PEELED commit, and the subfolder.
        assert failed.source == DatasetVersionSource(
            ref='v0.20.0',
            commit=peeled,
            git_url='https://github.com/laude-institute/harbor',
            path='examples/tasks/network-policy-matrix/extra-allowed-hosts',
        )
        # `upstream` stays the ACTIVE version's field — None when nothing
        # activated; the per-version source is the only honest carrier here.
        assert detail.upstream is None
        assert detail.selected_version.source.commit == peeled
        # Non-git and unreadable sources are None — never a fabricated value.
        assert upload.source is None
        assert garbage.source is None

    @pytest.mark.asyncio
    async def test_get_active_resolves_runnable_shape(self):
        fake = FakeUrlopen([
            ('/api/datasets/deep-swe', {
                'name': 'deep-swe',
                'title': 'DeepSWE',
                'description': 'SWE tasks',
                'active_version': {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                'versions': [
                    {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                    {'version': '1.0', 'state': 'ARCHIVED', 'created_at': '2026-07-01', 'task_count': 100},
                ],
                'selected_version': {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                'tasks': {
                    'items': [
                        {
                            'task_name': 'abs-module-cache-flags',
                            'agent_timeout_sec': 5400,
                            'verifier_timeout_sec': 1800,
                            'providers': ALL_OK_PROVIDERS,
                        },
                    ],
                    'nextCursor': None,
                    'hasMore': False,
                },
                'created_at': '2026-07-01',
                'updated_at': '2026-07-21',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            active = await datasets_factory(CONFIG).get_active('deep-swe')

        # Bare name — resolves the active version's task list (no ?version=)
        assert 'version=' not in fake.requests[0].full_url
        assert active.version == '1.1'                 # non-optional
        assert active.active_version.state == 'READY'
        assert len(active.tasks.items) == 1            # non-optional
        assert active.tasks.items[0].task_name == 'abs-module-cache-flags'
        assert active.tasks.items[0].providers['daytona'].ok is True
        assert len(active.versions) == 2

    @pytest.mark.asyncio
    async def test_get_active_raises_when_no_active_version(self):
        fake = FakeUrlopen([
            ('/api/datasets/draft-set', {
                'name': 'draft-set',
                'title': None,
                'description': None,
                'active_version': None,
                'versions': [{'version': '0.1', 'state': 'DRAFT', 'created_at': '2026-07-21', 'task_count': 0}],
                'selected_version': None,
                'tasks': {'items': [], 'nextCursor': None, 'hasMore': False},
                'created_at': '2026-07-21',
                'updated_at': '2026-07-21',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            with pytest.raises(NoActiveVersionError, match='no active version') as exc_info:
                await datasets_factory(CONFIG).get_active('draft-set')
        assert exc_info.value.dataset == 'draft-set'

    @pytest.mark.asyncio
    async def test_update_patches_the_one_settable_field(self):
        fake = FakeUrlopen([
            ('/api/datasets/deep-swe', {
                'name': 'deep-swe',
                'title': 'DeepSWE',
                'description': 'SWE tasks',
                'active_version': {'version': '1.1', 'state': 'READY', 'created_at': '2026-07-21', 'task_count': 113},
                'upstream': {
                    'ref': 'refs/heads/main',
                    'current_commit': 'abc123',
                    'latest_commit': 'def456',
                    'moved': True,
                    'behind_by': None,
                    'checked_at': '2026-07-29',
                    'error': None,
                    'auto_import': True,
                },
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            updated = await datasets_factory(CONFIG).update(
                'deep-swe', upstream_auto_import=True
            )

        request = fake.requests[0]
        assert request.get_method() == 'PATCH'
        assert json.loads(request.data.decode('utf-8')) == {'upstream_auto_import': True}
        assert updated.name == 'deep-swe'
        assert updated.upstream.auto_import is True

    @pytest.mark.asyncio
    async def test_publish_posts_git_source(self):
        fake = FakeUrlopen([
            ('/api/datasets/publish', {
                'id': 'imp-1', 'status': 'QUEUED', 'name': 'my-set', 'version': '1.2',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await datasets_factory(CONFIG).publish(
                git_url='https://github.com/org/bench.git',
                git_ref='v1.2.0',
                name='my-set',
                version='1.2',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        # ONE body grammar: multipart/form-data with named parts. Nothing rides
        # the query string, where it would land in access logs.
        assert request.full_url.endswith('/api/datasets/publish')
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts == {
            'name': b'my-set',
            'version': b'1.2',
            'git_url': b'https://github.com/org/bench.git',
            'git_ref': b'v1.2.0',
        }
        assert job.id == 'imp-1'
        assert job.status == 'QUEUED'
        assert job.name == 'my-set'
        assert job.version == '1.2'

    @pytest.mark.asyncio
    async def test_publish_git_path_rides_as_a_named_part(self):
        # git_path narrows the import to ONE repository subfolder (the server
        # fetches it via sparse checkout). Verbatim on the wire; absent when
        # not given (the root import above pins that: no git_path key at all).
        fake = FakeUrlopen([
            ('/api/datasets/publish', {
                'id': 'imp-2', 'status': 'QUEUED', 'name': 'my-set', 'version': '1.3',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            await datasets_factory(CONFIG).publish(
                git_url='https://github.com/org/monorepo.git',
                git_ref='v2',
                git_path='datasets/deep-swe',
                name='my-set',
                version='1.3',
            )

        parts = _multipart_parts(fake.requests[0])
        assert parts == {
            'name': b'my-set',
            'version': b'1.3',
            'git_url': b'https://github.com/org/monorepo.git',
            'git_ref': b'v2',
            'git_path': b'datasets/deep-swe',
        }

    @pytest.mark.asyncio
    async def test_publish_git_path_refused_with_a_directory(self, tmp_path):
        # A subfolder narrows a git clone, not a local directory — for a local
        # corpus the caller points directory= at the subfolder itself.
        with pytest.raises(ValueError, match='git_path'):
            await datasets_factory(CONFIG).publish(
                directory=str(tmp_path), git_path='tasks', name='b', version='1.0',
            )

    @pytest.mark.asyncio
    async def test_publish_uploads_a_directory(self, tmp_path):
        import io
        import tarfile

        from evolve.hosted import _tar_gzip_directory

        # A tiny corpus in the standard task layout on disk.
        task_dir = tmp_path / 'tasks' / 'abc'
        task_dir.mkdir(parents=True)
        (task_dir / 'task.toml').write_text('schema_version = "1.1"\n')

        fake = FakeUrlopen([
            ('/api/datasets/publish', {
                'id': 'imp-9', 'status': 'QUEUED', 'name': 'my-set', 'version': '0.1',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await datasets_factory(CONFIG).publish(
                directory=str(tmp_path),
                name='my-set',
                version='0.1',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        # Metadata is named PARTS FIRST, then the corpus as the `archive` part —
        # so the server can refuse a bad name before receiving the upload.
        assert request.full_url.endswith('/api/datasets/publish')
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert list(parts) == ['name', 'version', 'archive']
        assert parts['name'] == b'my-set'
        assert parts['version'] == b'0.1'

        data = parts['archive']
        assert data[:2] == b'\x1f\x8b'  # gzip magic
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r') as tar:
            names = tar.getnames()
        assert 'tasks/abc/task.toml' in names

        # Deterministic: the same directory always tars to the same bytes.
        assert _tar_gzip_directory(str(tmp_path)) == _tar_gzip_directory(str(tmp_path))

        assert job.id == 'imp-9'
        assert job.status == 'QUEUED'
        assert job.name == 'my-set'

    @pytest.mark.asyncio
    async def test_get_import_maps_status_and_warnings(self):
        fake = FakeUrlopen([
            ('/api/datasets/imports/imp-1', {
                'id': 'imp-1', 'status': 'COMPLETED', 'name': 'my-set',
                'version': '1.2', 'task_count': 113, 'failure': None,
                'warnings': [{'code': 'no_solutions_archived', 'message': 'no reference solutions were archived'}],
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await datasets_factory(CONFIG).get_import('imp-1')

        assert job.id == 'imp-1'
        assert job.status == 'COMPLETED'
        # Self-describing: a watcher holding only the id learns what it watches
        assert job.name == 'my-set'
        assert job.version == '1.2'
        assert job.task_count == 113
        assert job.failure is None
        # WARNINGS ARE CONSEQUENTIAL: a version with no archived solutions still
        # activates, but permanently lacks its reference-solution record — this
        # warning is the early notice. Dropping the field hid that.
        assert job.warnings[0].code == 'no_solutions_archived'
        assert job.warnings[0].message == 'no reference solutions were archived'

    @pytest.mark.asyncio
    async def test_get_import_maps_structured_failure(self):
        fake = FakeUrlopen([
            ('/api/datasets/imports/imp-2', {
                'id': 'imp-2',
                'status': 'FAILED',
                'name': 'my-set',
                'version': '1.2',
                'failure': {
                    'code': 'import_failed',
                    'message': '1/2 task(s) failed to parse',
                    'failures': [{'task_name': 'bad-task', 'error': 'boom'}],
                },
                'task_count': 0,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await datasets_factory(CONFIG).get_import('imp-2')

        assert job.status == 'FAILED'
        assert job.failure is not None
        assert job.failure.message == '1/2 task(s) failed to parse'
        assert job.failure.failures[0].task_name == 'bad-task'
        assert job.failure.failures[0].error == 'boom'

    @pytest.mark.asyncio
    async def test_watch_import_polls_until_terminal(self):
        job = {'id': 'imp-1', 'name': 'my-set', 'version': '1.2'}
        responses = iter([
            {**job, 'status': 'QUEUED'},
            {**job, 'status': 'RUNNING', 'task_count': 0},
            {**job, 'status': 'COMPLETED', 'task_count': 113},
        ])
        # After COMPLETED the watch follows the VERSION on the dataset detail;
        # an already-settled READY answer ends it on the first settle poll.
        detail = _settle_detail_body(state='READY', active=True)
        seen_urls = []

        def sequence_then_detail(request, timeout=None):
            seen_urls.append(request.full_url)
            if '/api/datasets/imports/' in request.full_url:
                return FakeResponse(next(responses))
            return FakeResponse(detail)

        statuses = []
        with patch('evolve._http.urlopen', sequence_then_detail):
            done = await datasets_factory(CONFIG).watch_import(
                'imp-1',
                on_status=lambda j: statuses.append(j.status),
                poll_interval_s=0.001,
            )

        assert done.status == 'COMPLETED'
        assert done.task_count == 113
        assert len([u for u in seen_urls if '/api/datasets/imports/' in u]) == 3
        assert statuses == ['QUEUED', 'RUNNING', 'COMPLETED']

    @pytest.mark.asyncio
    async def test_watch_import_survives_a_rate_limit(self):
        """A 429/503 mid-watch is a DELAY, not an outcome.

        The import keeps running server-side, so dying at the rate limit lost
        a watch over a wait. The loop sleeps the server's own delay — from the
        envelope on the 429, from the header on the 503 — and polls on.
        """
        import io
        import urllib.error

        job = {'id': 'imp-1', 'name': 'my-set', 'version': '1.2'}
        calls = {'import': 0, 'detail': 0}
        detail = _settle_detail_body(state='READY', active=True)

        def rate_limited_then_done(request, timeout=None):
            # The SETTLE phase lives under the same law: its first detail
            # poll is rate-limited too, and the watch sleeps the server's
            # delay and polls on.
            if '/api/datasets/imports/' not in request.full_url:
                calls['detail'] += 1
                if calls['detail'] == 1:
                    raise urllib.error.HTTPError(
                        request.full_url, 429, 'Too Many Requests', {},
                        io.BytesIO(json.dumps({'error': {
                            'code': 'rate_limited',
                            'message': 'slow down',
                            'retryAfterSec': 0.05,
                        }}).encode('utf-8')),
                    )
                return FakeResponse(detail)
            calls['import'] += 1
            if calls['import'] == 1:
                raise urllib.error.HTTPError(
                    request.full_url, 429, 'Too Many Requests', {},
                    io.BytesIO(json.dumps({'error': {
                        'code': 'rate_limited',
                        'message': 'slow down',
                        'retryAfterSec': 0.05,
                    }}).encode('utf-8')),
                )
            if calls['import'] == 2:
                raise urllib.error.HTTPError(
                    request.full_url, 503, 'Service Unavailable',
                    {'Retry-After': '0.05'},
                    io.BytesIO(b'upstream restarting'),
                )
            return FakeResponse({**job, 'status': 'COMPLETED', 'task_count': 113})

        started = time.monotonic()
        with patch('evolve._http.urlopen', rate_limited_then_done):
            done = await datasets_factory(CONFIG).watch_import(
                'imp-1', poll_interval_s=0.001
            )
        elapsed = time.monotonic() - started

        assert calls['import'] == 3
        assert calls['detail'] == 2
        assert done.status == 'COMPLETED'
        assert done.task_count == 113
        # All three delays were slept, not the 1ms poll interval.
        assert elapsed >= 0.12

        # Every other failure still ends the watch — survival is scoped to the
        # two statuses that MEAN "wait", never to a refusal.
        def not_found(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'dataset_not_found', 'message': 'no such import',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', not_found):
            with pytest.raises(EvolveAPIError) as exc:
                await datasets_factory(CONFIG).watch_import(
                    'imp-2', poll_interval_s=0.001
                )
        assert exc.value.status == 404

    @pytest.mark.asyncio
    async def test_watch_import_settles_past_completed(self):
        """THE SKEW THIS GUARDS AGAINST: under build-then-READY the server
        completes an import only when the version is READY, so the settle
        phase is normally one confirming read — but a MID-DEPLOY OLDER
        server can answer COMPLETED while its version is still short of
        READY. The watch must keep polling the dataset detail until the
        VERSION itself settles, never resolving a publish whose version a
        chained job start would refuse."""
        job = {'id': 'imp-1', 'name': 'my-set', 'version': '1.2',
               'failure': None, 'warnings': []}
        fake, calls, seen_urls = _settle_urlopen(
            [
                {**job, 'status': 'RUNNING', 'task_count': 0},
                {**job, 'status': 'COMPLETED', 'task_count': 113},
            ],
            [
                _settle_detail_body(state='BUILDING'),
                _settle_detail_body(state='BUILDING'),
                _settle_detail_body(state='BUILDING'),
                _settle_detail_body(state='READY', active=True),
            ],
        )

        transitions = []
        active_after_settle = []
        with patch('evolve._http.urlopen', fake):
            done = await datasets_factory(CONFIG).watch_import(
                'imp-1',
                poll_interval_s=0.001,
                on_version=lambda v, d: (
                    transitions.append(v.state),
                    active_after_settle.append(
                        d.active_version.version if d.active_version else None
                    ),
                ),
            )

        assert done.status == 'COMPLETED'
        detail_urls = [u for u in seen_urls if '/api/datasets/my-set?' in u]
        # COMPLETED alone is not a settled publish: the detail is polled,
        # pinned to the version this publish created, until READY.
        assert detail_urls, 'no dataset-detail poll happened after COMPLETED'
        assert 'version=1.2' in detail_urls[0]
        assert calls['detail'] == 4
        # on_version fires on every observed STATE change.
        assert transitions == ['BUILDING', 'READY']
        assert active_after_settle[-1] == '1.2'

    @pytest.mark.asyncio
    async def test_watch_import_surfaces_build_failure(self):
        """A version that settles FAILED fails the WATCH: the structured
        cause lands on the same row the import surface reads, so the watch
        re-reads the import and returns it FAILED — never a silent success.
        (The fixture wears a mid-deploy older server's shape: the import
        answered COMPLETED before the version settled; the watch reads only
        the STATE.)"""
        job = {'id': 'imp-9', 'name': 'my-set', 'version': '2.0', 'warnings': []}
        build_failure = {'code': 'import_failed',
                         'message': 'task image build failed for task-7'}
        fake, calls, seen_urls = _settle_urlopen(
            [
                {**job, 'status': 'COMPLETED', 'failure': None, 'task_count': 113},
                {**job, 'status': 'FAILED', 'task_count': 113,
                 'failure': build_failure},
            ],
            [
                _settle_detail_body(version='2.0', state='BUILDING'),
                _settle_detail_body(version='2.0', state='FAILED'),
            ],
        )

        transitions = []
        with patch('evolve._http.urlopen', fake):
            done = await datasets_factory(CONFIG).watch_import(
                'imp-9',
                poll_interval_s=0.001,
                on_version=lambda v, d: transitions.append(v.state),
            )

        assert done.status == 'FAILED'
        assert done.failure is not None
        assert done.failure.code == 'import_failed'
        assert transitions == ['BUILDING', 'FAILED']

    @pytest.mark.asyncio
    async def test_watch_import_archiving_disabled_settles_normally(self):
        """Solutions archiving disabled is a warning about the missing
        reference-solution record, never a settling dead end — the same
        import settles READY like any other."""
        job = {'id': 'imp-3', 'name': 'my-set', 'version': '1.4', 'failure': None,
               'warnings': [{'code': 'solutions_archiving_disabled',
                             'message': 'solutions archiving is disabled'}]}
        # The first detail read shows a not-yet-settled version (a mid-deploy
        # older server's shape); the watch keeps polling to READY.
        fake, calls, seen_urls = _settle_urlopen(
            [{**job, 'status': 'COMPLETED', 'task_count': 4}],
            [
                _settle_detail_body(version='1.4', state='BUILDING'),
                _settle_detail_body(version='1.4', state='READY', active=True),
            ],
        )

        with patch('evolve._http.urlopen', fake):
            done = await datasets_factory(CONFIG).watch_import(
                'imp-3', poll_interval_s=0.001
            )

        assert done.status == 'COMPLETED'
        assert calls['detail'] == 2

    @pytest.mark.asyncio
    async def test_watch_import_settle_timeout_backstop(self):
        """The bounded backstop: whatever else goes wrong (a mid-deploy
        older server that keeps answering a never-settling state), the
        settle wait is a bounded await — it ends with the named
        settle_timeout cause carrying the last observed state, never an
        unbounded hang."""
        import evolve as evolve_pkg
        settle_error = getattr(evolve_pkg, 'ImportSettleError', None)

        job = {'id': 'imp-4', 'name': 'my-set', 'version': '1.5',
               'failure': None, 'warnings': []}
        fake, calls, seen_urls = _settle_urlopen(
            [{**job, 'status': 'COMPLETED', 'task_count': 4}],
            [_settle_detail_body(version='1.5', state='BUILDING')],
        )

        with patch('evolve._http.urlopen', fake):
            with pytest.raises(Exception) as exc:
                await datasets_factory(CONFIG).watch_import(
                    'imp-4', poll_interval_s=0.001, settle_timeout_s=0.05
                )

        assert settle_error is not None and isinstance(exc.value, settle_error)
        assert exc.value.code == 'settle_timeout'
        assert exc.value.state == 'BUILDING'

    @pytest.mark.asyncio
    async def test_watch_import_settle_timeout_bounds_rate_limited_polls(self):
        """THE HOLE A REVIEW FOUND: the settle poll's 429/503 retry path
        skipped the deadline check, so a server answering nothing but rate
        limits turned the bounded settle wait into an infinite loop —
        ``publish --watch`` hung forever while a deploy answered 503. Both
        laws hold AT THE SAME TIME: a 429/503 is a delay, not an outcome,
        AND the settle deadline bounds the whole wait, retries included."""
        import io
        import urllib.error
        import evolve as evolve_pkg
        settle_error = getattr(evolve_pkg, 'ImportSettleError', None)

        job = {'id': 'imp-5', 'name': 'my-set', 'version': '1.6',
               'failure': None, 'warnings': []}
        calls = {'detail': 0}

        def rate_limited_settle(request, timeout=None):
            if '/api/datasets/imports/' in request.full_url:
                return FakeResponse({**job, 'status': 'COMPLETED', 'task_count': 4})
            calls['detail'] += 1
            raise urllib.error.HTTPError(
                request.full_url, 429, 'Too Many Requests', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'rate_limited', 'message': 'slow down',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', rate_limited_settle):
            with pytest.raises(Exception) as exc:
                # The proof itself is bounded: pre-fix this watch never
                # exits, so a hard cap turns the hang into a TimeoutError
                # instead of hanging the whole suite.
                await asyncio.wait_for(
                    datasets_factory(CONFIG).watch_import(
                        'imp-5', poll_interval_s=0.001, settle_timeout_s=0.05
                    ),
                    timeout=2,
                )

        assert settle_error is not None and isinstance(exc.value, settle_error)
        assert exc.value.code == 'settle_timeout'
        assert exc.value.state is None
        assert 'never observed' in str(exc.value)
        # The 429s WERE retried (delay, not outcome) before the deadline
        # ended the wait.
        assert calls['detail'] >= 2

    @pytest.mark.asyncio
    async def test_watch_import_failure_reread_survives_rate_limit(self):
        """The delay-not-outcome law covers the LAST read too: with the
        version settled FAILED, the final import re-read (the one that
        fetches the failure's structured cause) can itself be rate-limited —
        a transient 429 there must not turn a settled failure into a thrown
        rate-limit error."""
        import io
        import urllib.error

        job = {'id': 'imp-6', 'name': 'my-set', 'version': '2.1', 'warnings': []}
        build_failure = {'code': 'import_failed',
                         'message': 'task image build failed for task-2'}
        detail = _settle_detail_body(version='2.1', state='FAILED')
        calls = {'import': 0}

        def rate_limited_reread(request, timeout=None):
            if '/api/datasets/imports/' not in request.full_url:
                return FakeResponse(detail)
            calls['import'] += 1
            if calls['import'] == 1:
                return FakeResponse({**job, 'status': 'COMPLETED',
                                     'failure': None, 'task_count': 4})
            if calls['import'] == 2:
                raise urllib.error.HTTPError(
                    request.full_url, 429, 'Too Many Requests', {},
                    io.BytesIO(json.dumps({'error': {
                        'code': 'rate_limited', 'message': 'slow down',
                    }}).encode('utf-8')),
                )
            return FakeResponse({**job, 'status': 'FAILED',
                                 'failure': build_failure, 'task_count': 4})

        with patch('evolve._http.urlopen', rate_limited_reread):
            final = await datasets_factory(CONFIG).watch_import(
                'imp-6', poll_interval_s=0.001
            )

        assert calls['import'] == 3
        assert final.status == 'FAILED'
        assert final.failure is not None
        assert final.failure.code == 'import_failed'

    @pytest.mark.asyncio
    async def test_watch_import_failure_reread_is_bounded(self):
        """And when the rate limiting never relents, the final re-read is
        bounded by the SAME settle deadline — refusing with facts that stay
        true: the version settled FAILED (the state rides the error), the
        watch just could not fetch the final import body inside its
        budget."""
        import io
        import urllib.error
        import evolve as evolve_pkg
        settle_error = getattr(evolve_pkg, 'ImportSettleError', None)

        job = {'id': 'imp-7', 'name': 'my-set', 'version': '2.2', 'warnings': []}
        detail = _settle_detail_body(version='2.2', state='FAILED')
        calls = {'import': 0}

        def always_rate_limited_reread(request, timeout=None):
            if '/api/datasets/imports/' not in request.full_url:
                return FakeResponse(detail)
            calls['import'] += 1
            if calls['import'] == 1:
                return FakeResponse({**job, 'status': 'COMPLETED',
                                     'failure': None, 'task_count': 4})
            raise urllib.error.HTTPError(
                request.full_url, 429, 'Too Many Requests', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'rate_limited', 'message': 'slow down',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', always_rate_limited_reread):
            with pytest.raises(Exception) as exc:
                await asyncio.wait_for(
                    datasets_factory(CONFIG).watch_import(
                        'imp-7', poll_interval_s=0.001, settle_timeout_s=0.05
                    ),
                    timeout=2,
                )

        assert settle_error is not None and isinstance(exc.value, settle_error)
        assert exc.value.code == 'settle_timeout'
        assert exc.value.state == 'FAILED'
        assert 'settled FAILED' in str(exc.value)
        assert 'get_import("imp-7")' in str(exc.value)

    @pytest.mark.asyncio
    async def test_publish_requires_complete_git_source(self):
        client = datasets_factory(CONFIG)
        with pytest.raises(ValueError, match='git source'):
            await client.publish(git_url='', git_ref='main', name='b', version='1.0')
        # A git source still requires name AND version: its dataset.toml is only
        # readable after the server clones it, so the manifest cannot supply
        # them the way it can for a directory source.
        with pytest.raises(ValueError, match='cloned server-side'):
            await client.publish(git_url='g', git_ref='main', name='b')
        with pytest.raises(ValueError, match='cloned server-side'):
            await client.publish(git_url='g', git_ref='main', version='1.0')

    @pytest.mark.asyncio
    async def test_publish_directory_manifest_supplies_identity(self, tmp_path):
        # A corpus carrying dataset.toml publishes with NO name/version kwargs:
        # the parts are simply omitted and the server derives both from the
        # manifest (which also drives selection + digest verification there).
        (tmp_path / 'tasks' / 'abc').mkdir(parents=True)
        (tmp_path / 'tasks' / 'abc' / 'task.toml').write_text('schema_version = "1.1"\n')
        (tmp_path / 'dataset.toml').write_text(
            '[dataset]\nname = "acme/my-set"\nversion = "0.1"\n\n'
            '[[tasks]]\nname = "acme/abc"\ndigest = "sha256:' + '0' * 64 + '"\n'
        )
        fake = FakeUrlopen([
            ('/api/datasets/publish', {
                'id': 'imp-3', 'name': 'my-set', 'version': '0.1',
                'status': 'QUEUED', 'failure': None, 'warnings': [],
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            imported = await datasets_factory(CONFIG).publish(directory=str(tmp_path))
        body = fake.requests[0].data
        assert b'name="archive"' in body
        assert b'name="name"' not in body  # no name part — the manifest supplies it
        assert b'name="version"' not in body
        assert imported.name == 'my-set'
        assert imported.version == '0.1'

    @pytest.mark.asyncio
    async def test_publish_directory_without_manifest_needs_identity(self, tmp_path):
        # No flags and no manifest: refused BEFORE tarring/uploading anything.
        (tmp_path / 'tasks' / 'abc').mkdir(parents=True)
        (tmp_path / 'tasks' / 'abc' / 'task.toml').write_text('schema_version = "1.1"\n')
        fake = FakeUrlopen([])
        with patch('evolve._http.urlopen', fake):
            with pytest.raises(ValueError, match='dataset.toml'):
                await datasets_factory(CONFIG).publish(directory=str(tmp_path))
        assert fake.requests == []

    @pytest.mark.asyncio
    async def test_list_search_rides_every_page_fetch(self):
        fake = FakeUrlopen([
            ('/api/datasets', {'items': [], 'nextCursor': None, 'hasMore': False}),
        ])
        with patch('evolve._http.urlopen', fake):
            await datasets_factory(CONFIG).list(search='deep swe', limit=5)

        url = fake.requests[0].full_url
        # Sent verbatim (form-encoded, as the TS SDK's URLSearchParams does);
        # the server owns availability.
        assert 'search=deep+swe' in url
        assert 'limit=5' in url

    @pytest.mark.asyncio
    async def test_activate_posts_and_echoes_the_detail_shape(self):
        fake = FakeUrlopen([
            ('/api/datasets/my-swe/versions/1.0/activate', {
                'name': 'my-swe',
                'title': None,
                'description': None,
                'active_version': {'version': '1.0', 'state': 'READY', 'created_at': '2026-07-30', 'task_count': 12},
                'versions': [
                    {'version': '1.0', 'state': 'READY', 'created_at': '2026-07-30', 'task_count': 12},
                ],
                'selected_version': None,
                'tasks': {'items': [], 'nextCursor': None, 'hasMore': False},
                'created_at': '2026-07-30',
                'updated_at': '2026-07-30',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            dataset = await datasets_factory(CONFIG).activate('my-swe', '1.0')

        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/api/datasets/my-swe/versions/1.0/activate')
        # The echo is the same detail shape get() returns.
        assert dataset.active_version.version == '1.0'
        assert dataset.active_version.state == 'READY'
        # This body carries no latest_version key — an older server's answer,
        # and the absence must read as None rather than raise or echo
        # active_version.
        assert dataset.latest_version is None
        assert dataset.versions[0].task_count == 12

    @pytest.mark.asyncio
    async def test_activate_still_building_is_typed_409(self):
        """Build-then-READY: activate never answers 202 — a version still
        building refuses with the ordinary typed 409 ``version_not_ready``,
        and the publish lands READY (and active) on its own."""
        import io
        import urllib.error

        def refuse(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'version_not_ready',
                    'message': ('Dataset version my-swe@1.0 is in state BUILDING; '
                                'a publish lands READY (and active) on its own '
                                'when it finishes building'),
                    'details': {'state': 'BUILDING'},
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', refuse):
            with pytest.raises(EvolveAPIError) as exc:
                await datasets_factory(CONFIG).activate('my-swe', '1.0')

        assert exc.value.code == 'version_not_ready'
        assert exc.value.details == {'state': 'BUILDING'}


REGISTERED_AGENT = {
    'name': 'acme-cli',
    'source': 'install_script',
    'run_command': 'acme-cli --headless',
    'env': {'ACME_PROFILE': 'bench'},
    'created_at': '2026-07-24T00:00:00Z',
    'updated_at': '2026-07-24T00:00:00Z',
}


class TestSkills:
    @pytest.mark.asyncio
    async def test_upload_sends_the_folder_name_beside_the_content_archive(self, tmp_path):
        import io
        import tarfile

        from evolve import skills as skills_factory

        skill_dir = tmp_path / 'my-solo-skill'
        skill_dir.mkdir()
        (skill_dir / 'SKILL.md').write_text('# solo\n')

        fake = FakeUrlopen([
            ('/api/skills', {
                'skills': [{
                    'id': 'sk_1',
                    'name': 'my-solo-skill',
                    'digest': 'sha256:' + '0' * 64,
                    'size_bytes': 7,
                    'description': None,
                    'ref': 'upload:sk_1',
                    'created_at': '2026-08-01T00:00:00Z',
                }],
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            uploaded = await skills_factory(CONFIG).upload(str(skill_dir))

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        assert request.full_url.endswith('/api/skills')
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        # The archive packs the folder's CONTENT (SKILL.md at the archive
        # root), so the folder's own name MUST travel as a named part —
        # without it the server cannot name a single-skill upload.
        assert parts['name'] == b'my-solo-skill'
        data = parts['archive']
        assert data[:2] == b'\x1f\x8b'  # gzip magic
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r') as tar:
            names = tar.getnames()
        assert any(name.rstrip('/').endswith('SKILL.md') for name in names)

        assert uploaded[0].name == 'my-solo-skill'
        assert uploaded[0].ref == 'upload:sk_1'


class TestAgents:
    @pytest.mark.asyncio
    async def test_create_posts_the_install_script_as_named_parts(self):
        fake = FakeUrlopen([('/api/agents', REGISTERED_AGENT)])
        with patch('evolve._http.urlopen', fake):
            agent = await agents_factory(CONFIG).create(
                name='acme-cli',
                install_script='curl -fsSL https://acme.dev/install.sh | sh',
                run_command='acme-cli --headless',
                env={'ACME_PROFILE': 'bench'},
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        assert request.full_url.endswith('/api/agents')
        # ONE body grammar for both sources: multipart/form-data.
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts == {
            'name': b'acme-cli',
            'run_command': b'acme-cli --headless',
            'env': b'{"ACME_PROFILE": "bench"}',
            'install_script': b'curl -fsSL https://acme.dev/install.sh | sh',
        }

        assert agent.name == 'acme-cli'
        assert agent.source == 'install_script'
        assert agent.run_command == 'acme-cli --headless'
        assert agent.env == {'ACME_PROFILE': 'bench'}
        assert agent.created_at == '2026-07-24T00:00:00Z'

    @pytest.mark.asyncio
    async def test_create_uploads_a_directory_with_metadata_in_named_parts(self, tmp_path):
        import io
        import tarfile

        bin_dir = tmp_path / 'bin'
        bin_dir.mkdir(parents=True)
        (bin_dir / 'acme-cli').write_text('#!/bin/sh\nexec acme "$@"\n')

        fake = FakeUrlopen([
            ('/api/agents', {**REGISTERED_AGENT, 'source': 'tarball'}),
        ])
        with patch('evolve._http.urlopen', fake):
            agent = await agents_factory(CONFIG).create(
                name='acme-cli',
                directory=str(tmp_path),
                run_command='acme-cli --headless',
                env={'ACME_PROFILE': 'bench', 'ACME_REGION': 'us'},
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        # The run command and the declared env are named PARTS — in the query
        # string they would land in every access log and proxy buffer.
        assert request.full_url.endswith('/api/agents')
        assert urllib_parse.urlparse(request.full_url).query == ''
        assert request.get_header('Content-type').startswith('multipart/form-data; boundary=')
        parts = _multipart_parts(request)
        assert parts['name'] == b'acme-cli'
        assert parts['run_command'] == b'acme-cli --headless'
        assert json.loads(parts['env']) == {'ACME_PROFILE': 'bench', 'ACME_REGION': 'us'}

        data = parts['archive']
        assert data[:2] == b'\x1f\x8b'  # gzip magic
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(data)), mode='r') as tar:
            names = tar.getnames()
        assert 'bin/acme-cli' in names

        assert agent.source == 'tarball'

    @pytest.mark.asyncio
    async def test_create_requires_exactly_one_source(self):
        client = agents_factory(CONFIG)
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
            ('/api/agents/acme-cli', b''),
            ('/api/agents', {
                'items': [REGISTERED_AGENT], 'nextCursor': None, 'hasMore': False,
            }),
        ])
        # get() must resolve the detail route, so answer it before the list route.
        get_fake = FakeUrlopen([('/api/agents/acme-cli', REGISTERED_AGENT)])

        with patch('evolve._http.urlopen', fake):
            listed = await agents_factory(CONFIG).list()
        assert [agent.name for agent in listed.items] == ['acme-cli']
        assert listed.items[0].source == 'install_script'
        assert listed.next_cursor is None
        assert listed.has_more is False

        with patch('evolve._http.urlopen', get_fake):
            one = await agents_factory(CONFIG).get('acme-cli')
        assert get_fake.requests[0].full_url.endswith('/api/agents/acme-cli')
        assert one.run_command == 'acme-cli --headless'

        with patch('evolve._http.urlopen', fake):
            deleted = await agents_factory(CONFIG).delete('acme-cli')
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
                    'code': 'agent_not_found',
                    'message': 'No registered agent named "someone-elses".',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await agents_factory(CONFIG).get('someone-elses')
        assert exc.value.status == 404
        # Another owner's name reads as not-found — existence is never leaked.
        assert exc.value.code == 'agent_not_found'

    @pytest.mark.asyncio
    async def test_name_taken_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'agent_name_taken',
                    'message': 'You already registered an agent named "acme-cli".',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await agents_factory(CONFIG).create(
                    name='acme-cli', install_script='true', run_command='acme-cli'
                )
        assert exc.value.status == 409
        assert exc.value.code == 'agent_name_taken'


class TestJobs:
    @pytest.mark.asyncio
    async def test_start_posts_contract_body_in_field_order(self):
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[DatasetSelector(name='deep-swe', version='1.1', task_names=['abs-module-cache-flags'])],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                n_attempts=1,
                n_concurrent_trials=4,
                max_trial_spend_usd=25,
                idempotency_key='idem-abc',
            )

        request = fake.requests[0]
        assert request.get_method() == 'POST'
        body = json.loads(request.data.decode('utf-8'))
        assert body == {
            'datasets': [{'name': 'deep-swe', 'version': '1.1', 'task_names': ['abs-module-cache-flags']}],
            'agents': [{'name': 'codex', 'model_name': 'gpt-5.5'}],
            'n_attempts': 1,
            'n_concurrent_trials': 4,
            'max_trial_spend_usd': 25,
        }
        # Wire body is emitted in the contract's field order
        assert list(body) == [
            'datasets', 'agents', 'n_attempts', 'n_concurrent_trials', 'max_trial_spend_usd',
        ]
        assert request.get_header('Idempotency-key') == 'idem-abc'
        assert job.id == 'job-1'
        assert job.sandbox_provider == 'e2b'
        assert job.datasets[0].name == 'deep-swe'
        assert job.datasets[0].version == '1.1'
        # ONE "how many" structure: counts is entity cardinality, trials is the
        # total plus the status histogram.
        assert job.counts == JobCounts(agents=1, tasks=5)
        assert job.n_total_trials == 5
        assert job.trials.total == 5
        assert job.trials.by_status['QUEUED'] == 5
        assert job.idempotent_replay is False

    @pytest.mark.asyncio
    async def test_start_analyze_rides_the_wire(self):
        """``start(analyze=...)`` arms the embedded trigger: the config rides
        the body verbatim ({} legal — all defaults), and the response echoes
        the RESOLVED policy as ``Job.analyze``."""
        fake = FakeUrlopen([('/api/jobs', ANALYZED_JOB)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[DatasetSelector(name='deep-swe')],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                analyze={'model_name': 'claude-haiku-4-5-20251001'},
            )
        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['analyze'] == {'model_name': 'claude-haiku-4-5-20251001'}
        assert job.analyze == {
            'model_name': 'claude-haiku-4-5-20251001',
            'rubric': ANALYZE_RUBRIC,
        }

        # Omitted = no embedded analysis, and no analyze key on the wire.
        fake2 = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake2):
            bare = await jobs_factory(CONFIG).start(
                datasets=[DatasetSelector(name='deep-swe')],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
            )
        assert 'analyze' not in json.loads(fake2.requests[0].data.decode('utf-8'))
        assert bare.analyze is None

    @pytest.mark.asyncio
    async def test_agent_kwargs_ride_the_wire_and_map_back(self):
        # The --ak channel: kwargs (config above all) are part of the arm and
        # go out verbatim; the echoed arm maps kwargs back, and an older
        # server that omits the field reads as None, never a crash.
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        config = {'permissions': {'deny': ['WebSearch', 'WebFetch']}}
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[DatasetSelector(name='deep-swe')],
                agents=[AgentArm(name='claude', model_name='opus', kwargs={'config': config})],
            )
        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['agents'] == [
            {'name': 'claude', 'model_name': 'opus', 'kwargs': {'config': config}}
        ]

        from evolve.hosted import _map_agent_arm
        echoed = _map_agent_arm({
            'name': 'claude', 'model_name': 'opus', 'version': None,
            'reasoning_effort': None, 'kwargs': {'config': config},
        })
        assert echoed.kwargs == {'config': config}
        legacy = _map_agent_arm({'name': 'claude', 'model_name': 'opus'})
        assert legacy.kwargs is None
        garbage = _map_agent_arm({'name': 'claude', 'model_name': 'opus', 'kwargs': ['x']})
        assert garbage.kwargs is None

    @pytest.mark.asyncio
    async def test_agent_preset_rides_the_wire_and_maps_back(self):
        # The preset channel: the named bundle is part of the arm and goes out
        # verbatim; the echoed arm maps preset back, and an older server that
        # omits the field reads as None, never a crash.
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[DatasetSelector(name='deep-swe')],
                agents=[AgentArm(name='codex', model_name='gpt-5.6-sol', preset='no-internet')],
            )
        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['agents'] == [
            {'name': 'codex', 'model_name': 'gpt-5.6-sol', 'preset': 'no-internet'}
        ]

        from evolve.hosted import _map_agent_arm
        echoed = _map_agent_arm({
            'name': 'codex', 'model_name': 'gpt-5.6-sol', 'version': None,
            'reasoning_effort': None, 'kwargs': None, 'preset': 'no-internet',
        })
        assert echoed.preset == 'no-internet'
        legacy = _map_agent_arm({'name': 'codex', 'model_name': 'gpt-5.6-sol'})
        assert legacy.preset is None
        garbage = _map_agent_arm({'name': 'codex', 'model_name': 'gpt-5.6-sol', 'preset': 7})
        assert garbage.preset is None

    @pytest.mark.asyncio
    async def test_timeout_multipliers_ride_the_wire_and_map_back(self):
        # Harbor's five timeout knobs (their cli/jobs.py:378-424), flat on the
        # body exactly as Harbor's JobConfig carries them; unset ones send NO
        # key (the server's global-applies default is the ask). The echoed job
        # maps the five fields back, and an older server that omits them reads
        # as every phase at 1.0, never a crash.
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[DatasetSelector(name='deep-swe')],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                timeout_multiplier=2,
                verifier_timeout_multiplier=3,
            )
        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['timeout_multiplier'] == 2
        assert body['verifier_timeout_multiplier'] == 3
        assert 'agent_timeout_multiplier' not in body
        assert 'agent_setup_timeout_multiplier' not in body
        assert 'environment_build_timeout_multiplier' not in body

        from evolve.hosted import _map_job
        echoed = _map_job({
            **JOB_SUMMARY,
            'timeout_multiplier': 2,
            'agent_timeout_multiplier': None,
            'verifier_timeout_multiplier': 3,
            'agent_setup_timeout_multiplier': None,
            'environment_build_timeout_multiplier': None,
        })
        assert echoed.timeout_multiplier == 2
        assert echoed.verifier_timeout_multiplier == 3
        assert echoed.agent_timeout_multiplier is None
        legacy = _map_job(JOB_SUMMARY)
        assert legacy.timeout_multiplier == 1.0
        assert legacy.verifier_timeout_multiplier is None

    @pytest.mark.asyncio
    async def test_start_accepts_snake_case_dicts(self):
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe'}],
                agents=[{'name': 'codex', 'model_name': 'gpt-5.5', 'version': '0.29.0'}],
                max_trial_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['datasets'] == [{'name': 'deep-swe'}]
        assert body['agents'] == [
            {'name': 'codex', 'model_name': 'gpt-5.5', 'version': '0.29.0'},
        ]
        # camelCase keys are not part of the Python surface
        with pytest.raises(TypeError):
            await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe'}],
                agents=[{'name': 'codex', 'modelName': 'gpt-5.5'}],
                max_trial_spend_usd=25,
            )

    @pytest.mark.asyncio
    async def test_unknown_agent_version_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'agent_version_not_found',
                    'message': 'Agent "codex" has no version "9.9.9".',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await jobs_factory(CONFIG).start(
                    datasets=[{'name': 'deep-swe'}],
                    agents=[
                        AgentArm(name='codex', model_name='gpt-5.5', version='9.9.9'),
                    ],
                    max_trial_spend_usd=25,
                )
        assert exc.value.status == 404
        assert exc.value.code == 'agent_version_not_found'

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

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await jobs_factory(CONFIG).start(
                    datasets=[{'name': 'deep-swe'}],
                    agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                )
        assert exc.value.status == 402
        assert exc.value.code == 'insufficient_credits'

    @pytest.mark.asyncio
    async def test_non_exact_version_pin_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 400, 'Bad Request', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'invalid_input',
                    'message': 'version "^0.29.0" must be an exact version.',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await jobs_factory(CONFIG).start(
                    datasets=[{'name': 'deep-swe'}],
                    # A range cannot hold a comparison still, so it is refused.
                    agents=[
                        AgentArm(name='codex', model_name='gpt-5.5', version='^0.29.0'),
                    ],
                    max_trial_spend_usd=25,
                )
        assert exc.value.status == 400
        # A non-exact pin is invalid_input, not agent_version_not_found
        assert exc.value.code == 'invalid_input'
        assert 'exact version' in str(exc.value)

    @pytest.mark.asyncio
    async def test_unpinned_arm_sends_no_version(self):
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                max_trial_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # Omitted = resolve latest at dispatch; the key is absent, never null.
        assert body['agents'] == [{'name': 'codex', 'model_name': 'gpt-5.5'}]

    @pytest.mark.asyncio
    async def test_get_maps_detail(self):
        fake = FakeUrlopen([
            ('/api/jobs/job-1', {
                **JOB_SUMMARY,
                'status': 'RUNNING',
                'trials': trial_tally(SCORED=3, RUNNING=2),
                'stats': {'n_completed_trials': 3, 'n_errored_trials': 0, 'cost_usd': 2.79},
                'failure': None,
                'updated_at': '2026-07-22T00:05:00.000Z',
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).get('job-1')

        assert job.status == 'RUNNING'
        # EVERY status is named in the histogram so a UI never hardcodes the enum.
        assert job.trials.total == 5
        assert job.trials.by_status['SCORED'] == 3
        assert job.trials.by_status['CANCELLED'] == 0
        assert len(job.trials.by_status) == 8
        # stats is the wire's own dict — read by key, never constructed.
        assert job.stats['cost_usd'] == 2.79
        assert job.failure is None
        # `error` is the FAILURE envelope's key; it is never on a 200 body.
        assert not hasattr(job, 'error')
        assert not hasattr(job, 'trial_counts')
        arm = job.agents[0]
        assert (arm.name, arm.model_name, arm.version) == ('codex', 'gpt-5.5', None)
        assert not hasattr(arm, 'id')
        assert not hasattr(arm, 'system_digest')

    @pytest.mark.asyncio
    async def test_list_builds_cursor_params(self):
        fake = FakeUrlopen([
            ('/api/jobs', {
                'items': [{**JOB_SUMMARY, 'trials': trial_tally(SCORED=5)}],
                'nextCursor': 'job-0',
                'hasMore': True,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).list(limit=100, cursor='job-5')

        url = fake.requests[0].full_url
        assert 'limit=100' in url and 'cursor=job-5' in url
        assert page.next_cursor == 'job-0'
        assert page.has_more is True
        # A list row is the SAME shape as a get(): agents, failure and the
        # histogram ride along, so a dashboard needs no N+1 detail call.
        assert page.items[0].trials.by_status['SCORED'] == 5
        assert page.items[0].agents[0].name == 'codex'
        assert page.items[0].failure is None
        # Awaiting the handle fetches exactly one page (no cursor walk).
        assert len(fake.requests) == 1

    @pytest.mark.asyncio
    async def test_build_exclusions_map_and_default_empty(self):
        """The ran-N-of-M honesty label (partial-publish model) maps on every
        job read; an older server that sends none reads as "nothing was
        excluded" — never a crash."""
        labeled = dict(JOB_SUMMARY)
        labeled['build_exclusions'] = [
            {
                # Capped run: n_tasks_selected is the pre-cap matched-READY
                # count, and the note is the two-reasons capped form.
                'dataset': {'name': 'part-swe', 'version': '2.0'},
                'n_tasks_ran': 5,
                'n_tasks_selected': 100,
                'n_tasks_failed_to_build': 10,
                'failed_task_names': ['broken-dockerfile', 'schema-typo'],
                'note': 'selection matched 110 tasks: 10 failed to build: broken-dockerfile, schema-typo, …; ran 5 (n_tasks cap)',
            },
            {
                # Recorded before n_tasks_selected existed (older server
                # mid-deploy): answered as n_tasks_ran — read as uncapped.
                'dataset': {'name': 'old-swe', 'version': '1.0'},
                'n_tasks_ran': 10,
                'n_tasks_failed_to_build': 2,
                'failed_task_names': ['broken-dockerfile', 'schema-typo'],
                'note': 'ran 10 of 12 tasks — 2 failed to build (broken-dockerfile, schema-typo)',
            },
        ]
        fake = FakeUrlopen([('/api/jobs/job-1', labeled)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).get('job-1')
        assert job.build_exclusions == [
            JobBuildExclusion(
                dataset=DatasetRef(name='part-swe', version='2.0'),
                n_tasks_ran=5,
                n_tasks_selected=100,
                n_tasks_failed_to_build=10,
                failed_task_names=['broken-dockerfile', 'schema-typo'],
                note='selection matched 110 tasks: 10 failed to build: broken-dockerfile, schema-typo, …; ran 5 (n_tasks cap)',
            ),
            JobBuildExclusion(
                dataset=DatasetRef(name='old-swe', version='1.0'),
                n_tasks_ran=10,
                n_tasks_selected=10,
                n_tasks_failed_to_build=2,
                failed_task_names=['broken-dockerfile', 'schema-typo'],
                note='ran 10 of 12 tasks — 2 failed to build (broken-dockerfile, schema-typo)',
            ),
        ]

        fake = FakeUrlopen([('/api/jobs/job-1', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            older = await jobs_factory(CONFIG).get('job-1')
        assert older.build_exclusions == []

    @pytest.mark.asyncio
    async def test_every_job_response_is_the_same_shape(self):
        """Start, get and each list row carry the same fields.

        The rule this replaces: five responses, four different Job shapes, and a
        client that had to remember which call produced the one in its hand.
        """
        fake = FakeUrlopen([
            ('/api/jobs/job-1', JOB_SUMMARY),
            ('/api/jobs', {'items': [JOB_SUMMARY], 'nextCursor': None, 'hasMore': False}),
        ])
        with patch('evolve._http.urlopen', fake):
            client = jobs_factory(CONFIG)
            got = await client.get('job-1')
            listed = (await client.list()).items[0]

        assert vars(got).keys() == vars(listed).keys()
        # ...and it is the FULL shape, not a shared subset.
        assert sorted(vars(got)) == [
            'agent_setup_timeout_multiplier',
            'agent_timeout_multiplier',
            'agents',
            'analyze',
            'build_exclusions',
            'counts',
            'datasets',
            'environment_build_timeout_multiplier',
            'failure',
            'finished_at',
            'id',
            'idempotent_replay',
            'is_regrade',
            'job_name',
            'max_trial_spend_usd',
            'n_attempts',
            'n_concurrent_trials',
            'n_total_trials',
            'retry',
            'sandbox_provider',
            'source_jobs',
            'started_at',
            'stats',
            'status',
            'timeout_multiplier',
            'trials',
            'updated_at',
            'verifier_timeout_multiplier',
            'worst_case_spend_usd',
        ]

    @pytest.mark.asyncio
    async def test_failed_job_says_why_on_every_response(self):
        """The reason is `failure` ({code, message}), never `error`.

        `error` is the FAILURE envelope's key, so `if body.error: raise` has to
        stay correct on a healthy 200 read of a failed job — and the reason
        rides on LIST rows, so a dashboard needs no detail call per row.
        """
        failed = {
            **JOB_SUMMARY,
            'status': 'FAILED',
            'failure': {'code': 'job_execution_failed', 'message': 'dispatch exploded'},
        }
        fake = FakeUrlopen([
            ('/api/jobs', {'items': [failed], 'nextCursor': None, 'hasMore': False}),
        ])
        with patch('evolve._http.urlopen', fake):
            row = (await jobs_factory(CONFIG).list()).items[0]

        assert row.failure == JobFailure(code='job_execution_failed', message='dispatch exploded')
        assert not hasattr(row, 'error')

    @pytest.mark.asyncio
    async def test_list_auto_paginates_when_iterated(self):
        pages = {
            None: {
                'items': [{**JOB_SUMMARY, 'id': 'job-2'}, {**JOB_SUMMARY, 'id': 'job-1'}],
                'nextCursor': 'job-1',
                'hasMore': True,
            },
            'job-1': {
                'items': [{**JOB_SUMMARY, 'id': 'job-0'}],
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
        with patch('evolve._http.urlopen', fake):
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
        pages = {
            None: {
                'items': [wire_trial(id='run-1'), wire_trial(id='run-2', attempt=2)],
                'nextCursor': 'run-2',
                'hasMore': True,
            },
            'run-2': {'items': [wire_trial(id='run-3', attempt=3)], 'nextCursor': None, 'hasMore': False},
        }

        class PagedUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                query = urllib_parse.parse_qs(urllib_parse.urlsplit(request.full_url).query)
                cursor = query.get('cursor', [None])[0]
                return FakeResponse(pages[cursor])

        fake = PagedUrlopen([])
        trial_ids = []
        with patch('evolve._http.urlopen', fake):
            async for trial in jobs_factory(CONFIG).trials('job-1'):
                trial_ids.append(trial.id)

        assert trial_ids == ['run-1', 'run-2', 'run-3']
        # Await form still returns a single page.
        with patch('evolve._http.urlopen', PagedUrlopen([])) as _:
            single = await jobs_factory(CONFIG).trials('job-1', limit=2)
        assert len(single.items) == 2
        assert single.next_cursor == 'run-2'
        assert single.has_more is True

    @pytest.mark.asyncio
    async def test_trials_mapping_and_status_filter(self):
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [wire_trial()],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials(
                'job-1', status=['SCORED', 'SCORING_ERROR'], limit=1
            )

        url = fake.requests[0].full_url
        assert 'limit=1' in url
        assert 'status=SCORED%2CSCORING_ERROR' in url
        # No dataset filter asked for, none sent.
        assert 'dataset=' not in url
        trial = page.items[0]
        assert trial.task_name == 'abs-module-cache-flags'
        # The dataset each trial's task came from rides on the trial itself.
        assert trial.source == 'deep-swe'
        assert trial.attempt == 1
        assert trial.reward == 1
        # The full rewards map beside the convenience primary reward.
        assert trial.verifier_result.rewards == {'reward': 1, 'f2p': 1.0}
        # Spend lives on agent_result; spend_source names its lane.
        assert trial.agent_result.cost_usd == 0.93
        assert trial.agent_result.n_input_tokens == 1234
        assert trial.spend_source == 'measured'
        # Phase wall-clock is start/stop pairs, never durations.
        assert trial.agent_execution.started_at == '2026-07-22T00:00:40.000Z'
        assert trial.agent_execution.finished_at == '2026-07-22T00:04:03.000Z'
        # The finer pairs beside the four phase pairs — documented on this shape
        # before the mapper carried them, so a caller following the reference
        # block found nothing where the server had sent a pair.
        assert trial.queue_wait.started_at == '2026-07-21T23:59:30.000Z'
        assert trial.queue_wait.finished_at == '2026-07-22T00:00:00.000Z'
        assert trial.harness_bundle.finished_at == '2026-07-22T00:00:11.000Z'
        assert trial.image_prepare.finished_at == '2026-07-22T00:00:26.000Z'
        # Separate-mode trial: no shared-verify preparation segment exists.
        assert trial.shared_verify_setup is None
        # False is a real reading (the resolve produced the bytes), not absence.
        assert trial.harness_bundle_cache_hit is False
        # First-class run facts on list rows — same shape as the detail route
        assert trial.sandbox_provider == 'daytona'
        # Not a GPU-degraded trial; the field is honestly None, never absent-crash.
        assert trial.sandbox_provider_degrade is None
        assert trial.verifier_environment_mode == 'separate'
        assert trial.agent_info.version == 'codex-cli 0.145.0'
        assert trial.agent_info.model_info.name == 'gpt-5.5'
        # Where the trial ran: the agent's box and the verifier's box
        assert trial.sandbox_id == 'im8f0wgqwehvng70evvro'
        assert trial.verifier_sandbox_id == 'iv2k1xbqwehvng70evvrp'
        assert trial.session_ref == 'sess-9'
        # No judge ever ran: the judge pair is honestly None, never $0.
        assert trial.judge_result is None
        assert trial.judge_spend_source is None

    @pytest.mark.asyncio
    async def test_trial_judge_split_mapping(self):
        """Wave-3 lane 12: the judge share is itemized apart from the agent's —
        measured at the gateway off the judge key, with its own spend lane."""
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [wire_trial(
                    judge_result={
                        'n_input_tokens': 1200,
                        'n_cache_tokens': 0,
                        'n_output_tokens': 88,
                        'cost_usd': 0.0315,
                    },
                    judge_spend_source='measured',
                )],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials('job-1')

        trial = page.items[0]
        assert trial.judge_result.cost_usd == 0.0315
        assert trial.judge_result.n_input_tokens == 1200
        assert trial.judge_spend_source == 'measured'
        # The agent figure stays the agent's alone — the split is the point.
        assert trial.agent_result.cost_usd == 0.93

    @pytest.mark.asyncio
    async def test_trial_finer_timing_pairs_absence_is_none(self):
        """The finer pairs answer None when there is nothing to report.

        An older server sends none of these keys; a SHARED-mode verify that
        settled before its preparation pair was recorded sends the key as null.
        Both read None — never a zero-length pair, which would claim the
        segment ran and took no time.
        """
        older = wire_trial(id='trial-old')
        for key in (
            'queue_wait', 'harness_bundle', 'image_prepare',
            'shared_verify_setup', 'harness_bundle_cache_hit',
        ):
            del older[key]
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [
                    older,
                    # A stray 0/1 is not a reading: cache-hit is a bool or it
                    # is unrecorded, and False must never be inferred.
                    wire_trial(id='trial-int', harness_bundle_cache_hit=1),
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials('job-1')

        old, stray = page.items
        assert old.queue_wait is None
        assert old.harness_bundle is None
        assert old.image_prepare is None
        assert old.shared_verify_setup is None
        assert old.harness_bundle_cache_hit is None
        assert stray.harness_bundle_cache_hit is None

    @pytest.mark.asyncio
    async def test_trial_gpu_cost_mapping(self):
        """GPU COST (Wave-3 lane 5): ``gpu_cost`` maps through as the wire's
        own dict on GPU trials, None on every other trial and on a malformed
        object — and it is a SEPARATE figure, never folded into
        ``agent_result.cost_usd``."""
        record = {
            'estimate_usd': 3.9492,
            'unpriced_reason': None,
            'provider': 'modal',
            'gpu_type': 'H100',
            'declared_gpu_type': 'h100',
            'gpu_count': 1,
            'duration_sec': 3600,
            'rate_usd_per_gpu_sec': 0.001097,
            'rate_card': {'version': 1, 'source': 'modal.com/pricing', 'source_date': '2026-08-05'},
            'measured_from': '2026-07-22T00:00:10.000Z',
            'measured_to': '2026-07-22T01:00:10.000Z',
        }
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [
                    wire_trial(gpu_cost=record),
                    wire_trial(id='trial-cpu'),
                    wire_trial(id='trial-bad', gpu_cost='not-a-dict'),
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials('job-1')

        gpu, cpu, bad = page.items
        assert gpu.gpu_cost == record
        # SEPARATE by law: the model spend keeps its own number beside it.
        assert gpu.agent_result.cost_usd == 0.93
        # A non-GPU trial (field absent on the wire) reads None, never a crash…
        assert cpu.gpu_cost is None
        # …and so does a malformed value (defensive, like the degrade record).
        assert bad.gpu_cost is None

    @pytest.mark.asyncio
    async def test_trial_analysis_mapping(self):
        """``Trial.analysis`` maps through as the wire's own dict on analyzed
        trials — None on a never-analyzed trial and on a malformed value,
        never a fabricated empty object (the gpu_cost posture)."""
        record = {
            'id': 'an-1',
            'status': 'completed',
            'model_name': 'claude-haiku-4-5-20251001',
            'rubric': ANALYZE_RUBRIC,
            'summary': 'The agent solved the task without touching the tests.',
            'checks': {
                'reward_hacking': {
                    'outcome': 'pass',
                    'explanation': 'No verifier writes observed.',
                },
            },
            'estimated_cost_usd': 0.0173,
            'failure': None,
            'created_at': '2026-08-28T00:00:00.000Z',
            'finished_at': '2026-08-28T00:01:00.000Z',
        }
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [
                    wire_trial(analysis=record),
                    wire_trial(id='trial-bare'),
                    wire_trial(id='trial-bad', analysis='not-a-dict'),
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials('job-1')

        analyzed, bare, bad = page.items
        assert analyzed.analysis == record
        # The analyzer's spend is its OWN line — the trial's model spend keeps
        # its own number beside it.
        assert analyzed.agent_result.cost_usd == 0.93
        assert bare.analysis is None
        assert bad.analysis is None

    @pytest.mark.asyncio
    async def test_trial_provider_degrade_mapping(self):
        """GPU DEGRADE (Wave-3 lane 5): a well-formed record rides as exactly
        ``{'from','to','reason'}``; anything malformed — a missing key, a
        non-string value — reads None, never a crash and never a partial
        row. The same defensive rule as the TypeScript mapProviderDegrade."""
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [
                    wire_trial(sandbox_provider_degrade={
                        'from': 'e2b',
                        'to': 'modal',
                        'reason': 'e2b offers no GPU allocation',
                        'internal_ticket': 'never-rides',
                    }),
                    wire_trial(id='trial-partial',
                               sandbox_provider_degrade={'from': 'e2b'}),
                    wire_trial(id='trial-nonstring',
                               sandbox_provider_degrade={'from': 'e2b', 'to': 'modal', 'reason': 7}),
                ],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials('job-1')

        degraded, partial, nonstring = page.items
        # Exactly the three public keys — server internals never ride through.
        assert degraded.sandbox_provider_degrade == {
            'from': 'e2b',
            'to': 'modal',
            'reason': 'e2b offers no GPU allocation',
        }
        assert partial.sandbox_provider_degrade is None
        assert nonstring.sandbox_provider_degrade is None

    @pytest.mark.asyncio
    async def test_trials_dataset_filter(self):
        """``dataset=`` narrows to one dataset's trials — exact match on source."""
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [wire_trial()],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).trials('job-1', dataset='deep-swe', limit=1)

        url = fake.requests[0].full_url
        assert 'dataset=deep-swe' in url

    @pytest.mark.asyncio
    async def test_running_trial_surfaces_phase_and_live_spend(self):
        """attempt_phase + live_spent_usd: a polling caller can tell a slow
        build from a slow agent, and see money moving while it moves."""
        fake = FakeUrlopen([
            ('/api/jobs/job-1/trials', {
                'items': [wire_trial(
                    status='RUNNING',
                    reward=None,
                    verifier_result=None,
                    agent_result=None,
                    spend_source=None,
                    attempt_phase='agent',
                    live_spent_usd=0.41,
                    live_spend_at='2026-07-22T00:02:00.000Z',
                    finished_at=None,
                )],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).trials('job-1')

        trial = page.items[0]
        assert trial.attempt_phase == 'agent'
        # A mid-run LOWER BOUND, shown with its age, cleared at settle.
        assert trial.live_spent_usd == 0.41
        assert trial.live_spend_at == '2026-07-22T00:02:00.000Z'
        # The settled fields are honestly absent while it runs.
        assert trial.agent_result is None
        assert trial.spend_source is None

    @pytest.mark.asyncio
    async def test_trial_usage_reading_mapping(self):
        """The one-home usage reading maps verbatim into UsageReading; absent
        and malformed (no boolean ``provisional``) both read None — "the meter
        never answered", never a fabricated reading."""
        fake = FakeUrlopen([
            ('/api/trials/run-live', wire_trial(
                status='RUNNING',
                reward=None,
                verifier_result=None,
                agent_result=None,
                spend_source=None,
                finished_at=None,
                usage={
                    'provisional': True,
                    'spent_usd': 0.0421,
                    'input_tokens': 12345,
                    'cached_input_tokens': 4102,
                    'output_tokens': 2210,
                    'as_of': '2026-07-22T00:02:00.000Z',
                },
            )),
            ('/api/trials/run-absent', wire_trial(id='run-absent')),
            ('/api/trials/run-bad', wire_trial(id='run-bad', usage={'spent_usd': '0.42'})),
        ])
        with patch('evolve._http.urlopen', fake):
            client = trials_factory(CONFIG)
            live = await client.get('run-live')
            absent = await client.get('run-absent')
            malformed = await client.get('run-bad')

        assert live.usage is not None
        assert live.usage.provisional is True
        assert live.usage.spent_usd == 0.0421
        assert live.usage.input_tokens == 12345
        assert live.usage.cached_input_tokens == 4102
        assert live.usage.output_tokens == 2210
        assert live.usage.as_of == '2026-07-22T00:02:00.000Z'
        assert absent.usage is None
        assert malformed.usage is None

    @pytest.mark.asyncio
    async def test_cancel_and_resume(self):
        fake = FakeUrlopen([
            ('/cancel', {**JOB_SUMMARY, 'status': 'CANCELLING'}),
            ('/resume', {
                **JOB_SUMMARY,
                'id': 'job-2',
                'source_jobs': [{'action': 'resume', 'type': 'hub', 'job_id': 'job-1'}],
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            client = jobs_factory(CONFIG)
            cancelled = await client.cancel('job-1')
            resumed = await client.resume(
                'job-1',
                filter_error_types=['InfrastructureError'],
                idempotency_key='idem-rr',
            )

        assert cancelled.status == 'CANCELLING'
        assert fake.requests[0].get_method() == 'POST'
        # Resume = a NEW linked job; the source is never mutated.
        assert resumed.id == 'job-2'
        assert resumed.source_jobs == [SourceJob(action='resume', type='hub', job_id='job-1')]
        assert resumed.is_regrade is False
        sent = json.loads(fake.requests[1].data.decode('utf-8'))
        assert sent == {'filter_error_types': ['InfrastructureError']}
        assert fake.requests[1].get_header('Idempotency-key') == 'idem-rr'

    @pytest.mark.asyncio
    async def test_retry_job_selections(self):
        """jobs.retry() — the three selections ride the body verbatim, the
        response is a NEW linked job with action='retry' (its own verb, never
        resume's word)."""
        retry_job = {
            **JOB_SUMMARY,
            'id': 'job-4',
            'source_jobs': [{'action': 'retry', 'type': 'hub', 'job_id': 'job-1'}],
        }
        fake = FakeUrlopen([
            ('/retry', retry_job),
            ('/retry', retry_job),
            ('/retry', retry_job),
        ])
        with patch('evolve._http.urlopen', fake):
            client = jobs_factory(CONFIG)
            by_ids = await client.retry(
                'job-1', trial_ids=['run-1', 'run-2'], idempotency_key='idem-retry'
            )
            await client.retry('job-1', failed_only=True)
            await client.retry('job-1')

        assert by_ids.id == 'job-4'
        assert by_ids.source_jobs == [SourceJob(action='retry', type='hub', job_id='job-1')]
        assert by_ids.is_regrade is False
        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/api/jobs/job-1/retry')
        assert json.loads(fake.requests[0].data.decode('utf-8')) == {
            'trial_ids': ['run-1', 'run-2'],
        }
        assert fake.requests[0].get_header('Idempotency-key') == 'idem-retry'
        assert json.loads(fake.requests[1].data.decode('utf-8')) == {'failed_only': True}
        # No selection: the empty body — the whole (terminal) job retries.
        assert json.loads(fake.requests[2].data.decode('utf-8')) == {}

    @pytest.mark.asyncio
    async def test_retry_trial_returns_a_job(self):
        """trials.retry() — one settled trial, the trial id alone addresses
        it, and THE RESPONSE IS A JOB."""
        retry_job = {
            **JOB_SUMMARY,
            'id': 'job-5',
            'source_jobs': [{'action': 'retry', 'type': 'hub', 'job_id': 'job-1'}],
        }
        fake = FakeUrlopen([('/run-1/retry', retry_job)])
        with patch('evolve._http.urlopen', fake):
            job = await trials_factory(CONFIG).retry('run-1', idempotency_key='idem-tr')

        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/api/trials/run-1/retry')
        assert fake.requests[0].get_header('Idempotency-key') == 'idem-tr'
        assert job.id == 'job-5'
        assert job.source_jobs == [SourceJob(action='retry', type='hub', job_id='job-1')]

    @pytest.mark.asyncio
    async def test_retry_not_settled_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'trial_not_settled',
                    'message': 'Trial is RUNNING; retry requires a settled trial',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await trials_factory(CONFIG).retry('run-live')
        assert exc.value.status == 409
        assert exc.value.code == 'trial_not_settled'

    @pytest.mark.asyncio
    async def test_regrade_returns_a_job(self):
        """A regrade IS a job: source_jobs records the provenance, is_regrade
        derives from it, and viewing it is a plain jobs().get()."""
        regrade_job = {
            **JOB_SUMMARY,
            'id': 'job-3',
            'source_jobs': [{'action': 'regrade', 'type': 'hub', 'job_id': 'job-1'}],
            'is_regrade': True,
        }
        fake = FakeUrlopen([('/job-1/regrade', regrade_job)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).regrade(
                'job-1', statuses=['SCORED'], task_name='demo-task'
            )

        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/api/jobs/job-1/regrade')
        sent = json.loads(fake.requests[0].data.decode('utf-8'))
        assert sent == {'statuses': ['SCORED'], 'task_name': 'demo-task'}
        assert job.id == 'job-3'
        assert job.is_regrade is True
        assert job.source_jobs == [SourceJob(action='regrade', type='hub', job_id='job-1')]

    @pytest.mark.asyncio
    async def test_regrade_ineligible_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'regrade_source_ineligible',
                    'message': 'Trial used a shared-mode verifier; nothing faithful to re-run.',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await trials_factory(CONFIG).regrade('run-1')
        assert exc.value.status == 409
        assert exc.value.code == 'regrade_source_ineligible'

    @pytest.mark.asyncio
    async def test_analyze_posts_config_and_returns_the_job(self):
        """The config rides the body verbatim and THE RESPONSE IS THE JOB —
        analyses are not a separate resource. The resolved embedded policy
        and the stats aggregate map verbatim (plain wire dicts)."""
        fake = FakeUrlopen([('/job-1/analyze', ANALYZED_JOB)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).analyze(
                'job-1',
                model_name='claude-haiku-4-5-20251001',
                rubric=ANALYZE_RUBRIC,
            )

        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/api/jobs/job-1/analyze')
        sent = json.loads(fake.requests[0].data.decode('utf-8'))
        assert sent == {
            'model_name': 'claude-haiku-4-5-20251001',
            'rubric': ANALYZE_RUBRIC,
        }
        assert job.id == 'job-1'
        assert job.analyze == {
            'model_name': 'claude-haiku-4-5-20251001',
            'rubric': ANALYZE_RUBRIC,
        }
        assert job.stats['analysis'] == ANALYZED_JOB['stats']['analysis']

    @pytest.mark.asyncio
    async def test_analyze_defaults_send_the_empty_object(self):
        """Both arguments omitted sends {} — all defaults; the server owns
        the resolution. A job never analyzed reads analyze as None."""
        fake = FakeUrlopen([('/job-1/analyze', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).analyze('job-1')
        assert json.loads(fake.requests[0].data.decode('utf-8')) == {}
        assert job.analyze is None
        assert job.stats.get('analysis') is None

    @pytest.mark.asyncio
    async def test_analyze_already_running_is_typed_error(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 409, 'Conflict', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'analysis_already_running',
                    'message': 'An analysis wave is already running; retry once it settles.',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await jobs_factory(CONFIG).analyze('job-1')
        assert exc.value.status == 409
        assert exc.value.code == 'analysis_already_running'

    @pytest.mark.asyncio
    async def test_watch_analysis_polls_to_settled(self):
        """watch_analysis polls the job until nothing is pending; on_stats
        fires on every observed tally change with the job it came from."""
        pending = {
            **ANALYZED_JOB,
            'stats': {
                **ANALYZED_JOB['stats'],
                'analysis': {
                    'n_completed': 4,
                    'n_failed': 0,
                    'n_pending': 1,
                    'cost_usd': None,
                    'checks': {},
                },
            },
        }
        reads = {'n': 0}

        def fake(request, timeout=None):
            reads['n'] += 1
            return FakeResponse(pending if reads['n'] == 1 else ANALYZED_JOB, {}, 200)

        tallies = []
        with patch('evolve._http.urlopen', fake):
            final = await jobs_factory(CONFIG).watch_analysis(
                'job-1',
                on_stats=lambda job: tallies.append(
                    (
                        job.stats['analysis']['n_completed'],
                        job.stats['analysis']['n_failed'],
                        job.stats['analysis']['n_pending'],
                    )
                ),
                poll_interval_s=0.01,
            )

        assert reads['n'] == 2
        assert tallies == [(4, 0, 1), (5, 0, 0)]
        assert final.stats['analysis']['n_pending'] == 0

    @pytest.mark.asyncio
    async def test_download_bytes_and_streamed_file(self, tmp_path):
        archive = gzip.compress(json.dumps({'job': {'id': 'job-1'}}).encode('utf-8'))
        headers = {
            'Content-Disposition': 'attachment; filename="job-job-1-results.tar.gz"',
            'Content-Length': str(len(archive)),
            'x-package-sha256': hashlib.sha256(archive).hexdigest(),
        }
        fake = FakeUrlopen([('/download', archive, headers)])
        with patch('evolve._http.urlopen', fake):
            client = jobs_factory(CONFIG)
            payload = await client.download('job-1')
            path = await client.download('job-1', to=str(tmp_path))

        assert '/api/jobs/job-1/download' in fake.requests[0].full_url
        assert payload == archive
        assert path.endswith('job-job-1-results.tar.gz')
        with open(path, 'rb') as f:
            assert f.read() == archive

    @pytest.mark.asyncio
    async def test_download_refuses_bytes_failing_the_stated_digest(self):
        """The job archive gets the SAME integrity dance as the dataset
        package — it used to skip both checks twelve lines below them."""
        archive = gzip.compress(b'{}')
        headers = {'x-package-sha256': 'f' * 64}  # not the bytes above
        with patch(
            'evolve._http.urlopen',
            FakeUrlopen([('/download', archive, headers)]),
        ):
            with pytest.raises(EvolveDigestMismatchError):
                await jobs_factory(CONFIG).download('job-1')

    @pytest.mark.asyncio
    async def test_download_refuses_a_truncated_body(self):
        archive = gzip.compress(b'{}')
        headers = {'Content-Length': str(len(archive) + 1000)}
        with patch(
            'evolve._http.urlopen',
            FakeUrlopen([('/download', archive, headers)]),
        ):
            with pytest.raises(EvolveIncompleteDownloadError):
                await jobs_factory(CONFIG).download('job-1')

    @pytest.mark.asyncio
    async def test_compare_maps_aggregates_and_matrix(self):
        fake = FakeUrlopen([
            ('/api/jobs/compare', {
                'jobs': [
                    {
                        'id': 'job-1',
                        'datasets': [{'name': 'deep-swe', 'version': '1.1'}],
                        'status': 'COMPLETED',
                        'mean_reward': 0.0,  # zero is a reward, never nulled
                        'coverage': {'scored': 100, 'total': 113},
                        'cost_usd': 21.4,
                        'agents': [{'name': 'codex', 'model_name': 'gpt-5.5'}],
                        'started_at': '2026-07-22T00:00:00.000Z',
                    },
                    {
                        'id': 'job-2',
                        'datasets': [{'name': 'deep-swe', 'version': '1.1'}],
                        'status': 'COMPLETED',
                        'mean_reward': None,
                        'coverage': {'scored': 0, 'total': 113},
                        'cost_usd': 1.0,
                        'agents': [],
                        'started_at': '2026-07-22T01:00:00.000Z',
                    },
                ],
                # taskMatrix is one of the frozen camelCase wire keys.
                'taskMatrix': [
                    {
                        'task_name': 'abs-module-cache-flags',
                        'disagreement': True,
                        'cells': [
                            {
                                'job_id': 'job-1',
                                'status': 'SCORED',
                                'mean_reward': 1,
                                'coverage': {'scored': 1, 'total': 1},
                            },
                            {
                                'job_id': 'job-2',
                                'status': 'MISSING',
                                'mean_reward': None,
                                'coverage': {'scored': 0, 'total': 0},
                            },
                        ],
                    },
                ],
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            comparison = await jobs_factory(CONFIG).compare(['job-1', 'job-2'])

        assert 'ids=job-1,job-2' in fake.requests[0].full_url
        aggregate = comparison.jobs[0]
        assert aggregate.mean_reward == 0.0
        assert (aggregate.coverage.scored, aggregate.coverage.total) == (100, 113)
        assert aggregate.cost_usd == 21.4
        assert aggregate.datasets[0].name == 'deep-swe'
        assert aggregate.agents[0].name == 'codex'
        assert comparison.jobs[1].mean_reward is None
        row = comparison.task_matrix[0]
        assert row.task_name == 'abs-module-cache-flags'
        assert row.disagreement is True
        # Same statistic, same name, at every level of the compare payload
        assert row.cells[0].mean_reward == 1
        assert row.cells[1].status == 'MISSING'
        assert row.cells[1].mean_reward is None

    # ------------------------------------------------------------------ watch

    @pytest.mark.asyncio
    async def test_watch_streams_events_to_terminal(self):
        stream = sse_text([
            {'seq': 0, 'type': 'job.created', 'data': {'trial_count': 2}},
            {'seq': 1, 'type': 'trial.spend', 'data': {
                'trial_id': 'run-1', 'task_name': 'fix-bug', 'live_spent_usd': 3.41,
                'n_input_tokens': 1200, 'n_cache_tokens': 800, 'n_output_tokens': 300,
            }},
            {'seq': 2, 'type': 'trial.settled', 'data': {'trial_id': 'run-1', 'status': 'SCORED', 'reward': 1}},
        ]) + ': heartbeat\n\n' + sse_text([
            {'seq': 3, 'type': 'job.completed', 'data': {'scored': 2}},
        ])

        class WatchUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    return FakeSseResponse(stream.encode('utf-8'))
                return FakeResponse({**JOB_SUMMARY, 'status': 'COMPLETED'})

        fake = WatchUrlopen([])
        events = []
        with patch('evolve._http.urlopen', fake):
            final = await jobs_factory(CONFIG).watch(
                'job-1', on_event=lambda e: events.append(e)
            )

        assert [e.seq for e in events] == [0, 1, 2, 3]
        assert events[0].type == 'job.created'
        assert events[0].data == {'trial_count': 2}
        # trial.spend passes through verbatim, token sums included.
        assert events[1].type == 'trial.spend'
        assert events[1].data == {
            'trial_id': 'run-1', 'task_name': 'fix-bug', 'live_spent_usd': 3.41,
            'n_input_tokens': 1200, 'n_cache_tokens': 800, 'n_output_tokens': 300,
        }
        assert events[3].type == 'job.completed'
        assert final.status == 'COMPLETED'
        stream_request = next(r for r in fake.requests if '/events' in r.full_url)
        assert stream_request.get_header('Accept') == 'text/event-stream'
        assert stream_request.get_header('Last-event-id') is None

    @pytest.mark.asyncio
    async def test_watch_parses_cr_and_crlf_line_terminators(self):
        """The SSE grammar ends a line on CRLF, LF, or a LONE CR — a
        CR-terminated stream used to arrive as one endless line and no event
        ever surfaced."""
        stream = (
            'id: 0\revent: job.created\rdata: {"trial_count": 1}\r\r'
            'id: 1\r\nevent: job.completed\r\ndata: {"scored": 1}\r\n\r\n'
        )

        class WatchUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    return FakeSseResponse(stream.encode('utf-8'))
                return FakeResponse({**JOB_SUMMARY, 'status': 'COMPLETED'})

        fake = WatchUrlopen([])
        events = []
        with patch('evolve._http.urlopen', fake):
            final = await jobs_factory(CONFIG).watch(
                'job-1', on_event=lambda e: events.append(e)
            )

        assert [(e.seq, e.type) for e in events] == [(0, 'job.created'), (1, 'job.completed')]
        assert events[0].data == {'trial_count': 1}
        assert events[1].data == {'scored': 1}
        assert final.status == 'COMPLETED'

    @pytest.mark.asyncio
    async def test_watch_yields_events_when_iterated(self):
        """The dual-use handle: async-for yields each event, no second verb."""
        stream = sse_text([
            {'seq': 0, 'type': 'job.created', 'data': {}},
            {'seq': 1, 'type': 'job.completed', 'data': {}},
        ])

        class WatchUrlopen(FakeUrlopen):
            def __call__(self, request, timeout=None):
                self.requests.append(request)
                if '/events' in request.full_url:
                    return FakeSseResponse(stream.encode('utf-8'))
                return FakeResponse({**JOB_SUMMARY, 'status': 'COMPLETED'})

        fake = WatchUrlopen([])
        seqs = []
        with patch('evolve._http.urlopen', fake):
            async for event in jobs_factory(CONFIG).watch('job-1'):
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
                            {'seq': 1, 'type': 'trial.running', 'data': {'trial_id': 'run-1'}},
                        ]).encode('utf-8'))
                    return FakeSseResponse(sse_text([
                        {'seq': 2, 'type': 'job.completed', 'data': {}},
                    ]).encode('utf-8'))
                status = 'COMPLETED' if connects['count'] >= 2 else 'RUNNING'
                return FakeResponse({**JOB_SUMMARY, 'status': status})

        fake = ReconnectUrlopen([])
        events = []
        with patch('evolve._http.urlopen', fake):
            final = await jobs_factory(CONFIG).watch(
                'job-1', on_event=lambda e: events.append(e), reconnect_delay_s=0.001
            )

        assert connects['count'] == 2
        second_connect = [r for r in fake.requests if '/events' in r.full_url][1]
        assert second_connect.get_header('Last-event-id') == '1'
        assert [e.seq for e in events] == [0, 1, 2]
        assert final.status == 'COMPLETED'

    @pytest.mark.asyncio
    async def test_watch_sleeps_the_servers_retry_after_before_reconnecting(self):
        """The reconnect delay is the SERVER's when the server states one.

        Read by the one law — envelope first, ``Retry-After`` header second —
        so a rate-limited stream is not hammered back at the local backoff
        guess a millisecond later.
        """
        import io
        import urllib.error

        async def follow(status, reason, headers, body):
            connects = {'count': 0}

            def urlopen(request, timeout=None):
                if '/events' in request.full_url:
                    connects['count'] += 1
                    if connects['count'] == 1:
                        raise urllib.error.HTTPError(
                            request.full_url, status, reason, headers, io.BytesIO(body),
                        )
                    return FakeSseResponse(sse_text([
                        {'seq': 0, 'type': 'job.completed', 'data': {}},
                    ]).encode('utf-8'))
                return FakeResponse({**JOB_SUMMARY, 'status': 'COMPLETED'})

            started = time.monotonic()
            with patch('evolve._http.urlopen', urlopen):
                final = await jobs_factory(CONFIG).watch(
                    'job-1', reconnect_delay_s=0.001
                )
            return connects['count'], time.monotonic() - started, final.status

        connects, elapsed, status = await follow(
            429, 'Too Many Requests', {},
            json.dumps({'error': {
                'code': 'rate_limited', 'message': 'slow down', 'retryAfterSec': 0.08,
            }}).encode('utf-8'),
        )
        assert connects == 2
        assert status == 'COMPLETED'
        assert elapsed >= 0.06

        # The same law from the OTHER half of the wire: an unparseable body,
        # the delay in the header.
        connects, elapsed, status = await follow(
            503, 'Service Unavailable', {'Retry-After': '0.08'}, b'upstream restarting',
        )
        assert connects == 2
        assert status == 'COMPLETED'
        assert elapsed >= 0.06

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
                return FakeResponse({**JOB_SUMMARY, 'status': 'CANCELLED'})

        fake = QuietCloseUrlopen([])
        with patch('evolve._http.urlopen', fake):
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
                return FakeResponse({**JOB_SUMMARY, 'status': 'RUNNING'})

        fake = NeverTerminalUrlopen([])
        with patch('evolve._http.urlopen', fake):
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

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await jobs_factory(CONFIG).watch('job-x')
        assert exc_info.value.status == 404
        assert exc_info.value.code == 'job_not_found'
        assert 'Job not found: job-x' in str(exc_info.value)

    # ---------------------------------------------------------------- shapes

    @pytest.mark.asyncio
    async def test_start_posts_per_trial_cap(self):
        fake = FakeUrlopen([
            ('/api/jobs', {**JOB_SUMMARY, 'max_trial_spend_usd': 2, 'worst_case_spend_usd': 10}),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                max_trial_spend_usd=2,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['max_trial_spend_usd'] == 2
        assert list(body) == ['datasets', 'agents', 'max_trial_spend_usd']
        assert job.max_trial_spend_usd == 2
        # The cap alone does not say what the JOB can cost; the server does.
        assert job.worst_case_spend_usd == 10

    @pytest.mark.asyncio
    async def test_start_omits_absent_spend_cap(self):
        # max_trial_spend_usd is optional: the server applies its own default
        # ($200 per trial, operator-tunable) and the response echoes the
        # RESOLVED cap plus the worst case it implies for this job.
        fake = FakeUrlopen([
            ('/api/jobs', {**JOB_SUMMARY, 'max_trial_spend_usd': 200, 'worst_case_spend_usd': 1000}),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # ABSENT, never None: an explicit null would defeat the server-side
        # default the omission is asking for.
        assert 'max_trial_spend_usd' not in body
        assert body == {
            'datasets': [{'name': 'deep-swe', 'version': '1.1'}],
            'agents': [{'name': 'codex', 'model_name': 'gpt-5.5'}],
        }
        assert job.max_trial_spend_usd == 200
        assert job.worst_case_spend_usd == 1000

    @pytest.mark.asyncio
    async def test_start_posts_retry_policy_and_reads_the_echo(self):
        """`retry` rides the body in Harbor's vocabulary; the response echoes
        the RESOLVED policy and the job body carries it as a plain dict."""
        resolved = {
            'max_retries': 3,
            'include_exceptions': None,
            'exclude_exceptions': ['AgentAuthenticationError'],
            'wait_multiplier': 2.0,
            'min_wait_sec': 1.0,
            'max_wait_sec': 60.0,
        }
        fake = FakeUrlopen([
            ('/api/jobs', {**JOB_SUMMARY, 'retry': resolved, 'worst_case_spend_usd': 500}),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                retry={'max_retries': 3, 'exclude_exceptions': ['AgentAuthenticationError'],
                       'wait_multiplier': 2.0},
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['retry'] == {
            'max_retries': 3,
            'exclude_exceptions': ['AgentAuthenticationError'],
            'wait_multiplier': 2.0,
        }
        assert job.retry == resolved
        # The worst case reflects (max_retries + 1) — the server states it.
        assert job.worst_case_spend_usd == 500

    @pytest.mark.asyncio
    async def test_start_keeps_an_explicit_exclude_none_on_the_wire(self):
        """`'exclude_exceptions': None` is a MEANINGFUL wire value (Harbor's
        None: exclusions off entirely), distinct from omitting the key (the
        server's default set) — the client must send the null, never drop it."""
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                retry={'max_retries': 3, 'exclude_exceptions': None},
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['retry'] == {'max_retries': 3, 'exclude_exceptions': None}
        assert 'exclude_exceptions' in body['retry']

    @pytest.mark.asyncio
    async def test_start_omits_absent_retry_and_old_servers_read_as_off(self):
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        # ABSENT, never None: the omission asks for the server's fleet default.
        assert 'retry' not in body
        # JOB_SUMMARY carries no retry echo (an older server): the mapper
        # reads that as the retries-off policy with Harbor's defaults — every
        # field present, exactly like the TypeScript SDK's mapRetryConfig.
        assert job.retry == {
            'max_retries': 0,
            'include_exceptions': None,
            'exclude_exceptions': [],
            'wait_multiplier': 1.0,
            'min_wait_sec': 1.0,
            'max_wait_sec': 60.0,
        }

    @pytest.mark.asyncio
    async def test_job_retry_echo_fills_absent_fields_with_harbor_defaults(self):
        """A PARTIAL retry echo resolves field-by-field: the server's values
        ride through and anything absent (or unreadable) takes Harbor's own
        default — the same absent-tolerant reading as the TypeScript SDK."""
        fake = FakeUrlopen([
            ('/api/jobs/eval-1', {
                **JOB_SUMMARY,
                # max_retries rides; the rest is absent or garbage.
                'retry': {'max_retries': 5, 'wait_multiplier': 'fast'},
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).get('eval-1')

        assert job.retry == {
            'max_retries': 5,
            'include_exceptions': None,
            'exclude_exceptions': [],
            'wait_multiplier': 1.0,
            'min_wait_sec': 1.0,
            'max_wait_sec': 60.0,
        }
        # Every field is ALWAYS present — key reads never crash on any server.
        assert job.retry['max_wait_sec'] == 60.0

    @pytest.mark.asyncio
    async def test_start_posts_sandbox_provider(self):
        fake = FakeUrlopen([
            ('/api/jobs', {**JOB_SUMMARY, 'sandbox_provider': 'daytona'}),
        ])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                max_trial_spend_usd=25,
                sandbox_provider='daytona',
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['sandbox_provider'] == 'daytona'
        assert job.sandbox_provider == 'daytona'

    @pytest.mark.asyncio
    async def test_start_posts_job_name(self):
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            job = await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                job_name='deep-swe sweep',
                max_trial_spend_usd=25,
            )

        body = json.loads(fake.requests[0].data.decode('utf-8'))
        assert body['job_name'] == 'deep-swe sweep'
        assert job.job_name == 'deep-swe sweep'

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
                        'message': 'Job is RUNNING; download requires a terminal job',
                    },
                }).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await jobs_factory(CONFIG).download('job-1')
        error = exc_info.value
        assert error.status == 409
        assert error.code == 'job_not_terminal'
        # The message is the clean product sentence — no JSON, no status prefix
        assert str(error) == 'Job is RUNNING; download requires a terminal job'

    @pytest.mark.asyncio
    async def test_http_error_unparseable_body(self):
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 502, 'Bad Gateway', {},
                io.BytesIO(b'Bad Gateway'),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc_info:
                await jobs_factory(CONFIG).get('job-1')
        assert exc_info.value.status == 502
        assert exc_info.value.code == 'unknown_error'

    @pytest.mark.asyncio
    async def test_start_posts_env_pass_through_slots(self):
        """agent_env / verifier_env travel verbatim; the server owns acceptance."""
        fake = FakeUrlopen([('/api/jobs', JOB_SUMMARY)])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).start(
                datasets=[{'name': 'deep-swe'}],
                agents=[{'name': 'codex', 'model_name': 'gpt-5.5'}],
                agent_env={'ACME_PROFILE': 'bench'},
                verifier_env={'STRICT': '1'},
            )

        sent = json.loads(fake.requests[0].data.decode('utf-8'))
        assert sent['agent_env'] == {'ACME_PROFILE': 'bench'}
        assert sent['verifier_env'] == {'STRICT': '1'}

    @pytest.mark.asyncio
    async def test_list_search_rides_every_page_fetch(self):
        fake = FakeUrlopen([
            ('/api/jobs', {'items': [], 'nextCursor': None, 'hasMore': False}),
        ])
        with patch('evolve._http.urlopen', fake):
            await jobs_factory(CONFIG).list(search='deep', limit=10)

        url = fake.requests[0].full_url
        # Sent verbatim; the server owns availability.
        assert 'search=deep' in url
        assert 'limit=10' in url

    @pytest.mark.asyncio
    async def test_tasks_maps_the_per_task_rollup(self):
        fake = FakeUrlopen([
            ('/api/jobs/job-1/tasks', {
                'items': [
                    {
                        'task_name': 'abs-module-cache-flags',
                        'source': 'deep-swe',
                        'trials': trial_tally(SCORED=3, SCORING_ERROR=1),
                        'mean_reward': 0.67,
                        'cost_usd': 3.41,
                    },
                    {
                        # A task nothing has scored yet: None means "no mean",
                        # never a fabricated zero — zero is a reward.
                        'task_name': 'tricky-task',
                        'source': 'deep-swe',
                        'trials': trial_tally(QUEUED=4),
                        'mean_reward': None,
                        'cost_usd': None,
                    },
                ],
                'nextCursor': 'abs-module-cache-flags',
                'hasMore': True,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).tasks('job-1', limit=2)

        url = fake.requests[0].full_url
        assert '/api/jobs/job-1/tasks' in url
        assert 'limit=2' in url
        rollup = page.items[0]
        assert rollup.task_name == 'abs-module-cache-flags'
        # The dataset the task came from rides on the rollup.
        assert rollup.source == 'deep-swe'
        # The same zeros-included tally shape the job body carries.
        assert rollup.trials.total == 4
        assert rollup.trials.by_status['SCORED'] == 3
        assert rollup.trials.by_status['QUEUED'] == 0
        assert rollup.mean_reward == 0.67
        assert rollup.cost_usd == 3.41
        assert page.items[1].mean_reward is None
        assert page.items[1].cost_usd is None
        # The same page envelope as every other collection.
        assert page.next_cursor == 'abs-module-cache-flags'
        assert page.has_more is True


class TestTrials:
    @pytest.mark.asyncio
    async def test_get_is_globally_addressable(self):
        """One positional: a trial UUID needs no job id; job_id is the
        reverse pointer on the body."""
        fake = FakeUrlopen([
            ('/api/trials/run-1', wire_trial(
                verifier_sandbox_id=None,
                verifier_environment_mode='shared',
            )),
        ])
        with patch('evolve._http.urlopen', fake):
            trial = await trials_factory(CONFIG).get('run-1')

        assert fake.requests[0].full_url.endswith('/api/trials/run-1')
        assert trial.job_id == 'job-1'
        assert trial.task_name == 'abs-module-cache-flags'
        assert trial.agent_info.name == 'codex'
        assert trial.verifier_environment_mode == 'shared'
        # Shared mode boots no second box — None, never a KeyError.
        assert trial.verifier_sandbox_id is None
        assert trial.reward == 1

    @pytest.mark.asyncio
    async def test_trial_carries_the_auto_retry_lineage(self):
        """`n_retries` + `retries` — the retired attempts, typed, oldest first;
        a trial from an older server (neither key) reads 0 / []."""
        fake = FakeUrlopen([
            ('/api/trials/run-1', wire_trial(
                n_retries=1,
                retries=[{
                    'attempt_number': 1,
                    'exception_info': {
                        'exception_type': 'InfrastructureError',
                        'exception_message': 'sandbox died mid-run',
                        'exception_traceback': '',
                        'occurred_at': '2026-08-04T00:01:00.000Z',
                    },
                    'cost_usd': 0.12,
                    'started_at': '2026-08-04T00:00:00.000Z',
                    'settled_at': '2026-08-04T00:01:00.000Z',
                }],
            )),
            ('/api/trials/run-2', wire_trial(id='run-2')),
        ])
        with patch('evolve._http.urlopen', fake):
            client = trials_factory(CONFIG)
            retried = await client.get('run-1')
            plain = await client.get('run-2')

        assert retried.n_retries == 1
        assert len(retried.retries) == 1
        first = retried.retries[0]
        assert first.attempt_number == 1
        assert first.exception_info.exception_type == 'InfrastructureError'
        assert first.cost_usd == 0.12
        assert first.settled_at == '2026-08-04T00:01:00.000Z'
        # Old-server tolerance: absent keys read as never-retried.
        assert plain.n_retries == 0
        assert plain.retries == []

    @pytest.mark.asyncio
    async def test_trace_paging(self):
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
        with patch('evolve._http.urlopen', fake):
            page = await trials_factory(CONFIG).trace('run-1', cursor='2', limit=500)

        url = fake.requests[0].full_url
        assert '/api/trials/run-1/trace' in url
        assert 'cursor=2' in url and 'limit=500' in url
        assert [e.seq for e in page.items] == [3, 4]
        assert page.items[0].type == 'agent.message'
        assert page.next_cursor == '4'
        assert page.has_more is True

    @pytest.mark.asyncio
    async def test_artifact_selectors(self):
        fake = FakeUrlopen([
            ('stream=trace-stdout', {'log': 'raw agent stdout'}),
            ('stream=agent-home', {'files': {'/root/.claude/history.jsonl': '{}'}}),
            ('stream=verifier', {'log': None}),
        ])
        client = trials_factory(CONFIG)
        with patch('evolve._http.urlopen', fake):
            log = await client.artifact('run-1', 'trace-stdout')
            home = await client.artifact('run-1', 'agent-home')
            grader = await client.artifact('run-1', 'verifier')

        assert '/api/trials/run-1/trace?stream=trace-stdout' in fake.requests[0].full_url
        # Log selectors answer the text; agent-home answers path -> text.
        assert log == 'raw agent stdout'
        assert home == {'/root/.claude/history.jsonl': '{}'}
        # Never stored is a normal answer, not an error.
        assert grader is None
        # The signature says so too: the return annotation is the nullable
        # union (str | Dict[str, str] | None), not just the stored shapes.
        hints = typing.get_type_hints(client.artifact)
        assert typing.get_args(hints['return']) == (str, Dict[str, str], type(None))

    @pytest.mark.asyncio
    async def test_artifact_trace_atif_selector(self):
        """The trace-atif selector is log-shaped: the served ATIF document
        rides the same {log} envelope as the raw logs, and the client passes
        the JSON text through verbatim. (`trajectory` is a different,
        still-reserved selector — the harness-native session file.)"""
        fake = FakeUrlopen([('stream=trace-atif', {'log': '{"steps":[]}'})])
        client = trials_factory(CONFIG)
        with patch('evolve._http.urlopen', fake):
            log = await client.artifact('run-1', 'trace-atif')

        assert '/api/trials/run-1/trace?stream=trace-atif' in fake.requests[0].full_url
        assert log == '{"steps":[]}'
        # The Literal carries all seven selectors in the contract's own order —
        # trace-parsed first, agent-home last.
        hints = typing.get_type_hints(client.artifact)
        assert typing.get_args(hints['stream']) == (
            'trace-parsed', 'verifier', 'trace-stdout', 'trace-stderr', 'trace-atif', 'trajectory', 'agent-home',
        )

    @pytest.mark.asyncio
    async def test_artifact_refuses_trace_parsed_with_guidance(self):
        """'trace-parsed' is in the vocabulary but is not a raw artifact — the
        parsed event trace rides trace()/trace_events(), and artifact() refuses
        the selector with that guidance before any request leaves."""
        fake = FakeUrlopen([])
        client = trials_factory(CONFIG)
        with patch('evolve._http.urlopen', fake):
            with pytest.raises(ValueError, match=r'trace_events'):
                await client.artifact('run-1', 'trace-parsed')
        assert fake.requests == []

    @pytest.mark.asyncio
    async def test_trace_events_drains_pages(self):
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
        with patch('evolve._http.urlopen', fake):
            async for event in trials_factory(CONFIG).trace_events('run-1'):
                seqs.append(event.seq)

        assert seqs == [1, 2, 3]
        cursors = [
            urllib_parse.parse_qs(urllib_parse.urlsplit(r.full_url).query).get('cursor', [None])[0]
            for r in fake.requests
        ]
        assert cursors == [None, '2']

    @pytest.mark.asyncio
    async def test_trace_filters_ride_the_query(self):
        """type/grep/tail are spelled exactly as the spec spells them and
        compose with the cursor — the remote-inspection filter surface."""
        fake = FakeUrlopen([('/trace', {'items': [], 'nextCursor': None, 'hasMore': False})])
        with patch('evolve._http.urlopen', fake):
            await trials_factory(CONFIG).trace(
                'run-1', type='agent.message', grep='permission denied', tail=50, cursor='2'
            )
        query = urllib_parse.parse_qs(urllib_parse.urlsplit(fake.requests[0].full_url).query)
        assert query['type'] == ['agent.message']
        assert query['grep'] == ['permission denied']
        assert query['tail'] == ['50']
        assert query['cursor'] == ['2']

    @pytest.mark.asyncio
    async def test_job_grep_groups(self):
        """jobs().grep() — per-trial groups in the ordinary envelope, the
        sample events mapped through the one TraceEvent mapper."""
        fake = FakeUrlopen([
            ('/grep', {
                'items': [{
                    'trial_id': 'run-1',
                    'task_name': 'fix-bug',
                    'match_count': 7,
                    'events': [{'seq': 1, 'type': 'agent.message', 'data': {'text': 'permission denied'}}],
                }],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await jobs_factory(CONFIG).grep(
                'job-1', 'permission denied', type='agent.message', limit=10
            )
        url = fake.requests[0].full_url
        assert '/api/jobs/job-1/grep' in url
        query = urllib_parse.parse_qs(urllib_parse.urlsplit(url).query)
        assert query['q'] == ['permission denied']
        assert query['type'] == ['agent.message']
        assert query['limit'] == ['10']
        group = page.items[0]
        assert group.trial_id == 'run-1'
        assert group.task_name == 'fix-bug'
        assert group.match_count == 7
        assert group.events[0].type == 'agent.message'
        assert page.has_more is False

    @pytest.mark.asyncio
    async def test_trial_files_listing(self):
        """trials().files() — the read-only-filesystem listing."""
        fake = FakeUrlopen([
            ('/files', {
                'items': [{'path': 'verifier/verifier.log', 'size_bytes': 12}],
                'nextCursor': None,
                'hasMore': False,
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            page = await trials_factory(CONFIG).files('run-1', limit=5)
        url = fake.requests[0].full_url
        assert '/api/trials/run-1/files' in url and 'limit=5' in url
        assert page.items[0].path == 'verifier/verifier.log'
        assert page.items[0].size_bytes == 12

    @pytest.mark.asyncio
    async def test_trial_file_bytes_and_range(self):
        """trials().file() — raw bytes; the path's slashes ARE the route; the
        three Range spellings ride the header."""
        fake = FakeUrlopen([('/files/verifier/verifier.log', b'PASS checks')])
        client = trials_factory(CONFIG)
        with patch('evolve._http.urlopen', fake):
            whole = await client.file('run-1', 'verifier/verifier.log')
            await client.file('run-1', 'verifier/verifier.log', start=10, end=19)
            await client.file('run-1', 'verifier/verifier.log', start=10)
            await client.file('run-1', 'verifier/verifier.log', suffix=100)
        assert whole == b'PASS checks'
        assert fake.requests[0].full_url.endswith('/api/trials/run-1/files/verifier/verifier.log')
        assert fake.requests[0].headers.get('Range') is None
        assert fake.requests[1].headers.get('Range') == 'bytes=10-19'
        assert fake.requests[2].headers.get('Range') == 'bytes=10-'
        assert fake.requests[3].headers.get('Range') == 'bytes=-100'

    @pytest.mark.asyncio
    async def test_regrade_returns_a_job(self):
        regrade_job = {
            **JOB_SUMMARY,
            'id': 'job-4',
            'source_jobs': [{'action': 'regrade', 'type': 'hub', 'job_id': 'job-1'}],
            'is_regrade': True,
        }
        fake = FakeUrlopen([('/api/trials/run-1/regrade', regrade_job)])
        with patch('evolve._http.urlopen', fake):
            job = await trials_factory(CONFIG).regrade('run-1')

        assert fake.requests[0].get_method() == 'POST'
        assert fake.requests[0].full_url.endswith('/api/trials/run-1/regrade')
        assert job.id == 'job-4'
        assert job.is_regrade is True

    @pytest.mark.asyncio
    async def test_stop_posts_ids_and_maps_the_three_way_answer(self):
        fake = FakeUrlopen([
            ('/api/trials/stop', {
                'stopped': [wire_trial(id='run-1', status='INFRASTRUCTURE_ERROR', reward=None)],
                'already_terminal': ['run-2'],
                'not_found': ['run-3'],
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            outcome = await trials_factory(CONFIG).stop(['run-1', 'run-2', 'run-3'])

        assert fake.requests[0].get_method() == 'POST'
        sent = json.loads(fake.requests[0].data.decode('utf-8'))
        assert sent == {'trial_ids': ['run-1', 'run-2', 'run-3']}
        # Every requested id appears in exactly one list.
        assert [t.id for t in outcome.stopped] == ['run-1']
        assert outcome.stopped[0].status == 'INFRASTRUCTURE_ERROR'
        assert outcome.already_terminal == ['run-2']
        assert outcome.not_found == ['run-3']


class TestDatasetDownload:
    @pytest.mark.asyncio
    async def test_download_bytes_and_streamed_file(self, tmp_path):
        """The OWNER-ONLY corpus retrieval: bytes, or straight to a directory."""
        package = gzip.compress(b'corpus bytes')
        digest = hashlib.sha256(package).hexdigest()
        fake = FakeUrlopen([
            (
                '/download',
                package,
                {
                    'Content-Disposition': 'attachment; filename="acme@1.1-corpus.tar.gz"',
                    'x-package-sha256': digest,
                },
            ),
        ])
        with patch('evolve._http.urlopen', fake):
            client = datasets_factory(CONFIG)
            payload = await client.download('acme@1.1')
            path = await client.download('acme@1.1', to=str(tmp_path))

        assert payload == package
        with open(path, 'rb') as f:
            assert f.read() == package
        # A ref downloads by name; the version rides the query string.
        assert '/api/datasets/acme/download' in fake.requests[0].full_url
        assert 'version=1.1' in fake.requests[0].full_url

    @pytest.mark.asyncio
    async def test_download_refuses_a_backslash_filename(self, tmp_path):
        """Refused, not repaired: on POSIX ``a\\b.tar.gz`` is ONE legal
        filename, so treating the backslash as a separator renames the user's
        file on a guess about which platform wrote the header. Both SDKs fall
        back to their own name — one response, one file."""
        package = gzip.compress(b'corpus bytes')
        fake = FakeUrlopen([
            (
                '/download',
                package,
                {
                    'Content-Disposition': 'attachment; filename="a\\b.tar.gz"',
                    'x-package-sha256': hashlib.sha256(package).hexdigest(),
                },
            ),
        ])
        with patch('evolve._http.urlopen', fake):
            path = await datasets_factory(CONFIG).download('acme', to=str(tmp_path))

        assert os.path.basename(path) == 'acme-corpus.tar.gz'
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
            'evolve._http.urlopen',
            FakeUrlopen([('/download', package, headers)]),
        ):
            client = datasets_factory(CONFIG)
            first, second = await asyncio.gather(
                client.download('acme@1.1', to=str(tmp_path)),
                client.download('acme@1.1', to=str(tmp_path)),
            )

        assert first == second
        with open(first, 'rb') as f:
            assert f.read() == package
        # No scratch file survives either call.
        assert [p.name for p in tmp_path.iterdir()] == ['acme@1.1-corpus.tar.gz']

    @pytest.mark.asyncio
    async def test_download_refuses_bytes_failing_the_stated_digest(self, tmp_path):
        """The server hashes before sending; the client closes the wire half."""
        package = gzip.compress(b'corpus bytes')
        headers = {
            'Content-Disposition': 'attachment; filename="acme@1.1-corpus.tar.gz"',
            'x-package-sha256': 'f' * 64,  # not the bytes above
        }
        with patch(
            'evolve._http.urlopen',
            FakeUrlopen([('/download', package, headers)]),
        ):
            with pytest.raises(EvolveDigestMismatchError):
                await datasets_factory(CONFIG).download('acme')

        with patch(
            'evolve._http.urlopen',
            FakeUrlopen([('/download', package, headers)]),
        ):
            with pytest.raises(EvolveDigestMismatchError):
                await datasets_factory(CONFIG).download('acme', to=str(tmp_path))
        # A file that does not match its digest looks like the corpus and is
        # not, so it must not survive the failure.
        assert list(tmp_path.iterdir()) == []

    @pytest.mark.asyncio
    async def test_download_refuses_a_truncated_body(self, tmp_path):
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
            'evolve._http.urlopen',
            FakeUrlopen([('/download', package, headers)]),
        ):
            with pytest.raises(EvolveIncompleteDownloadError):
                await datasets_factory(CONFIG).download('acme')

        with patch(
            'evolve._http.urlopen',
            FakeUrlopen([('/download', package, headers)]),
        ):
            with pytest.raises(EvolveIncompleteDownloadError):
                await datasets_factory(CONFIG).download('acme', to=str(tmp_path))
        # Neither the final path nor the .part temp survives.
        assert list(tmp_path.iterdir()) == []

    @pytest.mark.asyncio
    async def test_download_refuses_a_traversing_filename(self, tmp_path):
        """The filename interpolates a user-supplied version label."""
        package = gzip.compress(b'corpus bytes')
        inner = tmp_path / 'inner'
        headers = {
            'Content-Disposition': 'attachment; filename="../../escaped.tar.gz"',
            'Content-Length': str(len(package)),
            'x-package-sha256': hashlib.sha256(package).hexdigest(),
        }
        with patch(
            'evolve._http.urlopen',
            FakeUrlopen([('/download', package, headers)]),
        ):
            path = await datasets_factory(CONFIG).download('acme', to=str(inner))

        assert path.startswith(str(inner))
        assert '..' not in path
        assert not (tmp_path / 'escaped.tar.gz').exists()

    @pytest.mark.asyncio
    async def test_download_not_retained_is_distinguishable(self):
        """A pre-retention version answers its own code, not dataset_not_found."""
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'package_not_retained',
                    'message': 'No original package is stored for version 0.9.',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await datasets_factory(CONFIG).download('acme@0.9')
        assert exc.value.status == 404
        assert exc.value.code == 'package_not_retained'


class TestAuth:
    @pytest.mark.asyncio
    async def test_status_maps_the_caller_and_key(self):
        fake = FakeUrlopen([
            ('/api/auth/status', {
                'user_id': 'user-7',
                'email': 'dev@acme.dev',
                'key': {
                    'id': 'key-3',
                    'label': 'ci',
                    'created_at': '2026-07-01T00:00:00.000Z',
                    'last_used_at': '2026-07-30T00:00:00.000Z',
                },
            }),
        ])
        with patch('evolve._http.urlopen', fake):
            status = await auth_factory(CONFIG).status()

        assert fake.requests[0].full_url.endswith('/api/auth/status')
        assert fake.requests[0].get_header('Authorization') == 'Bearer test-key'
        assert status.user_id == 'user-7'
        assert status.email == 'dev@acme.dev'
        # The key descriptor never carries the secret.
        assert status.key.id == 'key-3'
        assert status.key.label == 'ci'
        assert status.key.last_used_at == '2026-07-30T00:00:00.000Z'

    @pytest.mark.asyncio
    async def test_status_before_the_wave_is_a_typed_error(self):
        """Wave-gated: an older server answers not-found, surfaced honestly."""
        import io
        import urllib.error

        def raise_http_error(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 404, 'Not Found', {},
                io.BytesIO(json.dumps({'error': {
                    'code': 'not_found',
                    'message': 'Unknown route: /api/auth/status',
                }}).encode('utf-8')),
            )

        with patch('evolve._http.urlopen', raise_http_error):
            with pytest.raises(EvolveAPIError) as exc:
                await auth_factory(CONFIG).status()
        assert exc.value.status == 404


def test_usage_reading_refuses_non_finite_floats():
    from evolve.results import _usage_reading_from_data

    reading = _usage_reading_from_data(
        {"provisional": True, "spent_usd": float("nan"), "input_tokens": float("inf"),
         "cached_input_tokens": 5, "output_tokens": 2, "as_of": "2026-08-24T00:00:00Z"}
    )
    assert reading is not None
    assert reading.spent_usd is None
    assert reading.input_tokens is None
    assert reading.cached_input_tokens == 5
    assert reading.output_tokens == 2
