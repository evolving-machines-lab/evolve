"""
Unit tests for the hosted SDK's ergonomics work, and for TS/Python parity.

Parity is a law on this surface. ``watch()`` is the ONE dual-use handle in
both languages (await it OR iterate it) — the deprecated ``watch_iter`` split
is gone, so the SDK cannot disagree with itself or with TypeScript again.

Also covers:
- EvolveAPIError carrying param / details / retry_after_sec / request_id, and
  the truncation law (short sentence, complete data)
- the closed error-code vocabulary, asserted against the TypeScript list AND
  the Python Literal
- list_imports filters, datasets.delete, agents.upsert
- hosted() as one front door, with meta() reachable without an API key
- upstream version awareness on a dataset

Mocks urllib at the module boundary; no real network calls.
"""

import json
from unittest.mock import patch

import pytest

from evolve import (
    CapabilityDocument,
    EvolveAPIError,
    HostedClientConfig,
    HOSTED_ERROR_CODES,
    ManagedProviderCapability,
    UpstreamStatus,
    agents as agents_factory,
    datasets as datasets_factory,
    hosted,
    is_hosted_error_code,
    jobs as jobs_factory,
    meta as meta_fn,
)
from evolve.hosted import _map_upstream


CONFIG = HostedClientConfig(api_key='test-key', base_url='https://api.test')
EMPTY_PAGE = {'items': [], 'nextCursor': None, 'hasMore': False}


class FakeResponse:
    def __init__(self, body, headers=None):
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self._offset = 0
        self.headers = headers or {}

    def read(self, size=-1):
        if self._offset >= len(self._body):
            return b''
        chunk = self._body[self._offset:] if size is None or size < 0 else self._body[self._offset:self._offset + size]
        self._offset += len(chunk)
        return chunk

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeUrlopen:
    def __init__(self, responses):
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


def http_error(status, body, headers=None):
    """A urllib HTTPError whose body is the hosted failure envelope."""
    import io
    import urllib.error

    payload = json.dumps(body).encode('utf-8')
    return urllib.error.HTTPError(
        'https://api.test/x', status, 'Error', headers or {}, io.BytesIO(payload)
    )


# =============================================================================
# ERRORS A CLIENT CAN ACT ON
# =============================================================================

class TestErrorEnvelope:
    @pytest.mark.asyncio
    async def test_carries_param_details_and_request_id(self):
        """The refusal's machine-readable half, not just its sentence."""
        refused = [{'task_name': f't{i}', 'reason': 'no dockerd'} for i in range(11)]
        error_body = {
            'error': {
                'code': 'provider_unsupported',
                'message': '11 of 40 tasks cannot run on modal: t0; t1; t2; and 8 more',
                'param': 'sandbox_provider',
                'details': {'provider': 'modal', 'refused_tasks': refused},
                'requestId': 'req_abc123',
            }
        }

        def fake(request, timeout=None):
            raise http_error(400, error_body)

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        err = caught.value
        assert err.code == 'provider_unsupported'
        assert err.param == 'sandbox_provider'
        assert err.request_id == 'req_abc123'
        # The truncation law: the message named three, the data has all eleven.
        assert 'and 8 more' in str(err)
        assert len(err.details['refused_tasks']) == 11
        assert err.details['refused_tasks'][10]['task_name'] == 't10'

    @pytest.mark.asyncio
    async def test_retry_after_falls_back_to_the_header(self):
        def fake(request, timeout=None):
            raise http_error(
                429,
                {'error': {'code': 'rate_limited', 'message': 'slow down'}},
                {'Retry-After': '12', 'X-Request-Id': 'req_hdr'},
            )

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        assert caught.value.retry_after_sec == 12
        assert caught.value.request_id == 'req_hdr'

    @pytest.mark.asyncio
    async def test_a_body_delay_of_zero_still_beats_the_header(self):
        """Body-first means the body WINS, and 0 is a reading, not an absence.

        `or` falls through every falsy value, so an envelope stating 0 took the
        header's delay instead — TypeScript's readRetryAfterSec keeps the 0, and
        one law stated two ways in two SDKs is two laws.
        """

        def fake(request, timeout=None):
            raise http_error(
                429,
                {'error': {'code': 'rate_limited', 'message': 'slow down', 'retryAfterSec': 0}},
                {'Retry-After': '30'},
            )

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        assert caught.value.retry_after_sec == 0

    @pytest.mark.asyncio
    @pytest.mark.parametrize('raw', ['Infinity', '-Infinity', 'nan'])
    async def test_a_non_finite_header_reads_as_absent(self, raw):
        """A delay that cannot be waited is no reading at all.

        ``float('Infinity')`` succeeds and raises no ValueError, so the header
        rode through to every sleeper: ``watch_import`` and the event-stream
        reconnect both do ``sleep(max(delay, poll_interval))``, which parks
        forever with no bound and no output. TypeScript refuses the identical
        header through ``Number.isFinite`` — one law, both mirrors.
        """

        def fake(request, timeout=None):
            raise http_error(
                429,
                {'error': {'code': 'rate_limited', 'message': 'slow down'}},
                {'Retry-After': raw},
            )

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        assert caught.value.retry_after_sec is None

    @pytest.mark.asyncio
    async def test_a_non_finite_body_delay_falls_back_to_the_header(self):
        """The body wins only when it is finite — ``json.loads`` admits ``Infinity``.

        Python's parser reads the bare ``Infinity`` literal that JavaScript's
        ``JSON.parse`` throws on, so the envelope is the mirror's OWN way in for
        an unwaitable delay. Refusing it leaves the header as the reading.
        """

        def fake(request, timeout=None):
            raise http_error(
                429,
                {'error': {'code': 'rate_limited', 'message': 'slow down', 'retryAfterSec': float('inf')}},
                {'Retry-After': '5'},
            )

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        assert caught.value.retry_after_sec == 5

    @pytest.mark.asyncio
    async def test_a_boolean_body_delay_is_not_a_number(self):
        """``isinstance(True, int)`` is True in Python; ``typeof true`` is not
        "number" in TypeScript. The mirrors agree: a bool is not a delay."""

        def fake(request, timeout=None):
            raise http_error(
                429,
                {'error': {'code': 'rate_limited', 'message': 'slow down', 'retryAfterSec': True}},
                {},
            )

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        assert caught.value.retry_after_sec is None

    @pytest.mark.asyncio
    async def test_unparseable_body_still_yields_a_typed_error(self):
        import io
        import urllib.error

        def fake(request, timeout=None):
            raise urllib.error.HTTPError(
                'https://api.test/x', 502, 'Bad Gateway', {}, io.BytesIO(b'<html>nope</html>')
            )

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            with pytest.raises(EvolveAPIError) as caught:
                await datasets_factory(CONFIG).list()

        assert caught.value.code == 'unknown_error'
        assert not caught.value.is_known_code()

    def test_the_code_vocabulary_is_closed_and_exported(self):
        assert 'insufficient_credits' in HOSTED_ERROR_CODES
        assert 'dataset_not_found' in HOSTED_ERROR_CODES
        assert not is_hosted_error_code('insufficient_creidts')
        assert len(set(HOSTED_ERROR_CODES)) == len(HOSTED_ERROR_CODES)

    def test_the_vocabulary_matches_typescript(self):
        """TS/Python parity is a law; two drifting code lists break it silently."""
        from pathlib import Path
        import re

        ts_source = (
            Path(__file__).resolve().parents[3] / 'sdk-ts' / 'src' / 'hosted' / 'types.ts'
        ).read_text()
        block = re.search(
            r'export const HOSTED_ERROR_CODES = \[(.*?)\] as const;', ts_source, re.S
        )
        assert block, 'HOSTED_ERROR_CODES not found in the TypeScript SDK'
        ts_codes = re.findall(r'"([a-z_]+)"', block.group(1))
        assert ts_codes == list(HOSTED_ERROR_CODES)

        # THE LITERAL TOO. Python states the vocabulary TWICE — once as the
        # runtime tuple above, once as the HostedErrorCode Literal a type
        # checker reads — and only the tuple was asserted. A code deleted from
        # the Literal alone left green tests and a type that silently rejected
        # a code the server can actually send.
        py_source = (
            Path(__file__).resolve().parents[1].parent / 'evolve' / 'hosted.py'
        ).read_text()
        literal = re.search(
            r'HostedErrorCode = Literal\[(.*?)\]', py_source, re.S
        )
        assert literal, 'HostedErrorCode Literal not found in the Python SDK'
        literal_codes = re.findall(r"'([a-z_]+)'", literal.group(1))
        assert set(literal_codes) == set(HOSTED_ERROR_CODES), (
            'HostedErrorCode Literal and HOSTED_ERROR_CODES disagree: '
            f'{set(literal_codes) ^ set(HOSTED_ERROR_CODES)}'
        )


# =============================================================================
# THE FIND-IT-AGAIN AND REPLACE-IN-ONE-CALL VERBS
# =============================================================================

class TestMissingVerbs:
    @pytest.mark.asyncio
    async def test_list_imports_passes_its_filters(self):
        """Lose the 202's id and an import used to be unwatchable forever."""
        fake = FakeUrlopen([('/api/datasets/imports', EMPTY_PAGE)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await datasets_factory(CONFIG).list_imports(
                status='FAILED', dataset='deep-swe', limit=10
            )

        url = fake.requests[0].full_url
        assert '/api/datasets/imports' in url
        assert 'status=FAILED' in url
        assert 'dataset=deep-swe' in url
        assert 'limit=10' in url

    @pytest.mark.asyncio
    async def test_dataset_delete_sends_delete(self):
        fake = FakeUrlopen([('/api/datasets/typo', {})])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await datasets_factory(CONFIG).delete('typo')

        assert fake.requests[0].get_method() == 'DELETE'
        assert fake.requests[0].full_url.endswith('/api/datasets/typo')

    @pytest.mark.asyncio
    async def test_upsert_is_one_put_with_the_name_in_the_path(self):
        """delete()+create() leaves a window where the agent does not exist."""
        agent = {
            'name': 'my-agent',
            'source': 'install_script',
            'run_command': 'x',
            'env': {},
            'created_at': '',
            'updated_at': '',
        }
        fake = FakeUrlopen([('/api/agents/my-agent', agent)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await agents_factory(CONFIG).upsert(
                'my-agent',
                run_command='my-agent --headless',
                install_script='curl -fsSL https://example.test/install.sh | sh',
            )

        assert len(fake.requests) == 1, 'exactly one call — no delete-then-create window'
        assert fake.requests[0].get_method() == 'PUT'
        assert fake.requests[0].full_url.endswith('/api/agents/my-agent')
        assert 'multipart/form-data' in fake.requests[0].get_header('Content-type')

    @pytest.mark.asyncio
    async def test_upsert_refuses_a_bad_source_before_sending_anything(self):
        client = agents_factory(CONFIG)
        with pytest.raises(ValueError):
            await client.upsert('a', run_command='x', install_script='y', directory='/tmp')
        with pytest.raises(ValueError):
            await client.upsert('a', run_command='x')


# =============================================================================
# WATCH PARITY WITH TYPESCRIPT
# =============================================================================

class TestWatchParity:
    def test_watch_returns_a_dual_use_handle(self):
        """One method, awaitable OR iterable — the TypeScript shape."""
        handle = jobs_factory(CONFIG).watch('job-1')
        assert hasattr(handle, '__await__'), 'await j.watch(id) must resolve the final job'
        assert hasattr(handle, '__aiter__'), 'async for over j.watch(id) must yield events'

    def test_watch_is_not_a_coroutine(self):
        """It returns a handle, so `async for` works without awaiting first."""
        import inspect

        handle = jobs_factory(CONFIG).watch('job-1')
        assert not inspect.iscoroutine(handle)

    def test_watch_iter_is_gone(self):
        """The deprecated split verb was deleted with the breaking wave —
        carrying a second spelling of watch() through a rename would have
        preserved the exact asymmetry the dual-use handle closed."""
        assert not hasattr(jobs_factory(CONFIG), 'watch_iter')

    def test_list_uses_the_same_dual_use_idiom(self):
        """Which is the internal consistency argument for the watch() shape."""
        handle = jobs_factory(CONFIG).list()
        assert hasattr(handle, '__await__')
        assert hasattr(handle, '__aiter__')


# =============================================================================
# ONE FRONT DOOR
# =============================================================================

class TestFrontDoor:
    @pytest.mark.asyncio
    async def test_config_is_passed_once(self):
        fake = FakeUrlopen([('/api/datasets', EMPTY_PAGE)])
        client = hosted(CONFIG)
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            await client.datasets.list()

        assert fake.requests[0].full_url.startswith('https://api.test')
        assert fake.requests[0].get_header('Authorization') == 'Bearer test-key'

    def test_clients_are_built_once_and_reused(self):
        client = hosted(CONFIG)
        assert client.datasets is client.datasets
        assert client.jobs is client.jobs
        assert client.agents is client.agents
        assert client.trials is client.trials

    @pytest.mark.asyncio
    async def test_meta_needs_no_api_key(self, monkeypatch):
        """A signed-out page has to be able to populate its own agent picker."""
        monkeypatch.delenv('EVOLVE_API_KEY', raising=False)
        document = {
            'schema_version': 3,
            'agents': [
                {
                    'name': 'claude',
                    'effort_support': True,
                    'version_pinnable': True,
                    'latest_version': '1.2.3',
                }
            ],
            'agent_registration': {'max_per_user': 25},
            'sandbox_providers': [
                {'name': 'e2b', 'default': True, 'sizing': {'max_cpus': 8}, 'refuses': []}
            ],
            'managed_providers': [
                {
                    'name': 'e2b',
                    'configured': True,
                    'requires_config': ['EVOLVE_INTERNAL_PROXY_SECRET'],
                    'missing_config': [],
                    'agent_sessions': True,
                    'agent_sessions_reason': None,
                }
            ],
            'platform_constraints': [],
            'network_modes': ['no-network'],
            'statuses': {
                'job': {
                    'values': ['QUEUED', 'COMPLETED'],
                    'terminal': ['COMPLETED'],
                    'description': 'x',
                }
            },
            'limits': {'job': {'max_trials': 10000}},
            'import_warning_codes': ['no_solutions_archived'],
            'error_codes': ['invalid_input'],
        }
        fake = FakeUrlopen([('/api/meta', document)])

        with patch('evolve.hosted.urllib.request.urlopen', fake):
            result = await meta_fn(HostedClientConfig(base_url='https://api.test'))

        assert isinstance(result, CapabilityDocument)
        assert result.schema_version == 3
        assert result.agents[0].effort_support is True
        assert result.agents[0].latest_version == '1.2.3'
        assert result.statuses['job'].terminal == ['COMPLETED']
        assert result.sandbox_providers[0].default is True
        # The door list is objects, never bare names — a client asks each door
        # whether it is configured and whether it can carry an agent session.
        assert result.managed_providers == [
            ManagedProviderCapability(
                name='e2b',
                configured=True,
                requires_config=['EVOLVE_INTERNAL_PROXY_SECRET'],
                missing_config=[],
                agent_sessions=True,
                agent_sessions_reason=None,
            )
        ]
        # An import that can never activate must be recognizable from here.
        assert result.import_warning_codes == ['no_solutions_archived']
        # No credentials went out.
        assert fake.requests[0].get_header('Authorization') is None

    @pytest.mark.asyncio
    async def test_reaching_for_jobs_without_a_key_still_fails(self, monkeypatch):
        monkeypatch.delenv('EVOLVE_API_KEY', raising=False)
        client = hosted()
        # Lazily, at the first request rather than at construction — so meta()
        # stays usable on the same object.
        with pytest.raises(ValueError):
            await client.jobs.get('job-1')


# =============================================================================
# UPSTREAM VERSION AWARENESS
# =============================================================================

class TestUpstream:
    @pytest.mark.asyncio
    async def test_dataset_carries_the_upstream_comparison(self):
        detail = {
            'name': 'deep-swe',
            'title': None,
            'description': None,
            'active_version': None,
            'versions': [],
            'selected_version': None,
            'tasks': EMPTY_PAGE,
            'upstream': {
                'ref': 'main',
                'current_commit': 'a' * 40,
                'latest_commit': 'b' * 40,
                'moved': True,
                'behind_by': None,
                'checked_at': '2026-07-24T00:00:00.000Z',
                'error': None,
            },
            'created_at': '',
            'updated_at': '',
        }
        fake = FakeUrlopen([('/api/datasets/deep-swe', detail)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            dataset = await datasets_factory(CONFIG).get('deep-swe')

        assert isinstance(dataset.upstream, UpstreamStatus)
        assert dataset.upstream.moved is True
        # The watcher never fetches a commit graph, so this stays None.
        assert dataset.upstream.behind_by is None

    @pytest.mark.asyncio
    async def test_a_missing_upstream_field_reads_as_nothing_to_watch(self):
        detail = {
            'name': 'old',
            'title': None,
            'description': None,
            'active_version': None,
            'versions': [],
            'selected_version': None,
            'tasks': EMPTY_PAGE,
            'created_at': '',
            'updated_at': '',
        }
        fake = FakeUrlopen([('/api/datasets/old', detail)])
        with patch('evolve.hosted.urllib.request.urlopen', fake):
            dataset = await datasets_factory(CONFIG).get('old')

        assert dataset.upstream is None

    def test_upstream_status_never_claims_moved_on_an_unknown_answer(self):
        """None is "nothing to watch", never "up to date"."""
        never_checked = _map_upstream(
            {
                'ref': 'main',
                'current_commit': 'a' * 40,
                'latest_commit': None,
                'moved': False,
                'behind_by': None,
                'checked_at': None,
                'error': None,
            }
        )
        assert never_checked.moved is False
        assert never_checked.checked_at is None
