"""The chunked-resumable archive upload — the Python twin of the TS lane.

Above RESUMABLE_UPLOAD_THRESHOLD_BYTES a dataset corpus rides upload
sessions (sequential verified chunks; a dropped link resumes from the last
acknowledged one) instead of one fragile request. The loop is Harbor's own
resumable client re-expressed against our door (REFERENCES/Harbor
src/harbor/storage/resumable.py:106-149), and these tests hold it to the
same laws the TS suite (hosted-resumable.test.ts) holds its twin to,
against a REAL local HTTP server holding a REAL in-memory session:

- the archive arrives EXACTLY (whole-file sha256 over the reassembly), in
  6 MiB-law chunks (overridden small here) with the TUS-spelled
  Upload-Checksum verified per chunk;
- THE RESUME SEAM: a connection that dies mid-chunk costs one HEAD re-probe
  and the transfer continues from the acknowledged offset — chunks the
  server landed are never re-sent;
- a re-probe that itself dies while the link is still down spends only
  that round's attempt — the transfer survives and completes (fb41406);
- typed refusals raise EvolveAPIError through the shared mapper;
- a server that keeps dropping exhausts RESUMABLE_UPLOAD_MAX_ATTEMPTS;
- a lost finalize response is retried (complete is idempotent by state).
"""

import base64
import hashlib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from evolve.hosted import (
    RESUMABLE_UPLOAD_CHUNK_BYTES,
    RESUMABLE_UPLOAD_MAX_ATTEMPTS,
    RESUMABLE_UPLOAD_THRESHOLD_BYTES,
    EvolveAPIError,
    _HostedHttp,
    _upload_archive_resumable,
)
from evolve.config import HostedClientConfig

CHUNK = 64 * 1024


class SessionState:
    def __init__(self, size: int, sha256: str, fields: dict):
        self.size = size
        self.sha256 = sha256
        self.fields = fields
        self.received: 'list[bytes]' = []
        self.offset = 0
        self.patch_offsets: 'list[int]' = []
        self.completed = 0


def make_server(faults: dict):
    """A REAL minimal session server; ``faults`` injects one behavior once."""
    sessions: 'dict[str, SessionState]' = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: D102 — quiet
            pass

        def _json(self, status: int, body: dict):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            if self.path == '/api/datasets/publish/uploads':
                if faults.get('create_refuses'):
                    self._json(413, {'error': {'code': 'import_too_large', 'message': 'over the cap'}})
                    return
                parsed = json.loads(body)
                state = SessionState(
                    parsed['size'],
                    parsed['sha256'],
                    {k: v for k, v in parsed.items() if k not in ('size', 'sha256')},
                )
                sessions[f'up-{len(sessions) + 1}'] = state
                self._json(201, {'id': f'up-{len(sessions)}', 'state': 'RECEIVING', 'offset': 0})
                return
            if self.path.endswith('/complete'):
                state = sessions[self.path.split('/')[-2]]
                if faults.get('drop_first_complete') and state.completed == 0 and not faults.get('_complete_dropped'):
                    faults['_complete_dropped'] = True
                    self.connection.close()
                    return
                if state.offset != state.size:
                    self._json(409, {'error': {'code': 'upload_incomplete', 'message': 'missing bytes'}})
                    return
                state.completed += 1
                self._json(202, {'id': 'version-1', 'status': 'QUEUED', 'name': state.fields.get('name')})
                return
            self.send_response(404)
            self.end_headers()

        def do_HEAD(self):
            state = sessions.get(self.path.split('/')[-1])
            if state is None:
                self.send_response(404)
                self.end_headers()
                return
            if faults.get('drop_first_head') and not faults.get('_head_dropped'):
                # The link is still down when the recovery probe goes out.
                faults['_head_dropped'] = True
                self.connection.close()
                return
            self.send_response(200)
            self.send_header('Upload-Offset', str(state.offset))
            self.send_header('Upload-Length', str(state.size))
            self.end_headers()

        def do_PATCH(self):
            state = sessions.get(self.path.split('/')[-1])
            if state is None:
                self.send_response(404)
                self.end_headers()
                return
            offset = int(self.headers['Upload-Offset'])
            state.patch_offsets.append(offset)
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            if faults.get('drop_every_patch'):
                self.connection.close()
                return
            kill_nth = faults.get('kill_patch_n')
            if kill_nth is not None and len(state.patch_offsets) == kill_nth and not faults.get('_patch_killed'):
                # The mid-chunk link kill: the chunk NEVER lands, no answer.
                faults['_patch_killed'] = True
                self.connection.close()
                return
            drop_nth = faults.get('drop_patch_ack_n')
            if offset != state.offset:
                self._json(409, {'error': {'code': 'upload_offset_mismatch', 'message': 'not next',
                                           'details': {'expected_offset': state.offset}}})
                return
            declared = self.headers.get('Upload-Checksum', '')
            digest = base64.b64decode(declared.split(' ', 1)[1]).hex() if ' ' in declared else None
            if digest != hashlib.sha256(body).hexdigest():
                self._json(400, {'error': {'code': 'upload_chunk_digest_mismatch', 'message': 'bad chunk'}})
                return
            state.received.append(body)
            state.offset += len(body)
            if drop_nth is not None and len(state.patch_offsets) == drop_nth and not faults.get('_ack_dropped'):
                # The lost-ack seam: the chunk LANDED, only the answer dies.
                faults['_ack_dropped'] = True
                self.connection.close()
                return
            self.send_response(204)
            self.send_header('Upload-Offset', str(state.offset))
            self.end_headers()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, sessions


@pytest.fixture()
def archive(tmp_path):
    data = os.urandom(CHUNK * 3 + 1234)
    path = tmp_path / 'corpus.tar.gz'
    path.write_bytes(data)
    return str(path), data


def run_upload(server, archive_path, fields=None, chunk=CHUNK):
    import asyncio

    http = _HostedHttp(
        'datasets',
        HostedClientConfig(api_key='k', base_url=f'http://127.0.0.1:{server.server_address[1]}'),
    )
    # The 6 MiB production chunk is the law; tests shrink it to prove the
    # loop without 6 MiB buffers (the TS suite's chunkBytes override).
    # sys.modules, because evolve/__init__ exports a FUNCTION named `hosted`
    # that shadows the submodule on attribute lookup.
    import sys

    hosted = sys.modules['evolve.hosted']
    original = hosted.RESUMABLE_UPLOAD_CHUNK_BYTES
    hosted.RESUMABLE_UPLOAD_CHUNK_BYTES = chunk
    try:
        return asyncio.run(_upload_archive_resumable(http, archive_path, fields or {}))
    finally:
        hosted.RESUMABLE_UPLOAD_CHUNK_BYTES = original


def test_constants_are_harbor_parity():
    assert RESUMABLE_UPLOAD_CHUNK_BYTES == 6 * 1024 * 1024  # resumable.py:21
    assert RESUMABLE_UPLOAD_MAX_ATTEMPTS == 4  # resumable.py:20
    assert RESUMABLE_UPLOAD_THRESHOLD_BYTES == 256 * 1024 * 1024  # recorded deviation


def test_happy_path_bytes_arrive_exactly(archive):
    path, data = archive
    server, sessions = make_server({})
    try:
        raw = run_upload(server, path, {'name': 'deep-swe', 'version': '1.1', 'org': None})
        assert raw['id'] == 'version-1'
        state = list(sessions.values())[0]
        assert state.fields == {'name': 'deep-swe', 'version': '1.1'}  # None omitted
        assert hashlib.sha256(b''.join(state.received)).hexdigest() == hashlib.sha256(data).hexdigest()
        assert len(state.received) == 4  # 3 full chunks + the tail
    finally:
        server.shutdown()


def test_lost_ack_resumes_from_probe_never_resends(archive):
    path, data = archive
    server, sessions = make_server({'drop_patch_ack_n': 2})
    try:
        raw = run_upload(server, path)
        assert raw['status'] == 'QUEUED'
        state = list(sessions.values())[0]
        assert hashlib.sha256(b''.join(state.received)).hexdigest() == hashlib.sha256(data).hexdigest()
        # The landed-but-unheard chunk was not re-sent: its offset appears once.
        assert state.patch_offsets.count(CHUNK) == 1
        assert state.patch_offsets.count(0) == 1
    finally:
        server.shutdown()


def test_probe_failure_during_recovery_spends_attempt_never_transfer(archive):
    """evolve fb41406: the link that killed a chunk mid-flight is usually
    still down when the recovery HEAD goes out. That probe failure spends
    nothing but the round's attempt (the next round re-probes — Harbor's
    outer retry wraps its probes the same way, resumable.py:34-40); before
    the fix it propagated and killed the whole transfer."""
    path, data = archive
    server, sessions = make_server({'kill_patch_n': 2, 'drop_first_head': True})
    try:
        raw = run_upload(server, path)
        assert raw['status'] == 'QUEUED'
        state = list(sessions.values())[0]
        assert hashlib.sha256(b''.join(state.received)).hexdigest() == hashlib.sha256(data).hexdigest()
        # Exactly one attempt spent: the killed chunk went out twice (killed,
        # then landed at its own offset); chunk 1 was never re-sent.
        assert state.patch_offsets.count(CHUNK) == 2
        assert state.patch_offsets.count(0) == 1
    finally:
        server.shutdown()


def test_typed_refusal_raises_evolve_api_error(archive):
    path, _ = archive
    server, _sessions = make_server({'create_refuses': True})
    try:
        with pytest.raises(EvolveAPIError) as excinfo:
            run_upload(server, path)
        assert excinfo.value.code == 'import_too_large'
        assert excinfo.value.status == 413
    finally:
        server.shutdown()


def test_persistent_drops_exhaust_the_attempt_budget(archive):
    path, _ = archive
    server, _sessions = make_server({'drop_every_patch': True})
    try:
        with pytest.raises(Exception) as excinfo:
            run_upload(server, path)
        assert not isinstance(excinfo.value, EvolveAPIError)  # transport, not a refusal
    finally:
        server.shutdown()


def test_lost_finalize_response_is_retried(archive):
    path, _ = archive
    server, sessions = make_server({'drop_first_complete': True})
    try:
        raw = run_upload(server, path)
        assert raw['id'] == 'version-1'
        assert list(sessions.values())[0].completed == 1
    finally:
        server.shutdown()
