"""``on_upload_progress`` actually fires — on BOTH transports.

``datasets().publish(directory=..., on_upload_progress=cb)`` promises a
``(sent_bytes, total_bytes)`` callback as the archive's bytes go onto the
wire, fired from the uploader thread (the upload runs in
``asyncio.to_thread``). These tests hold that promise against a REAL local
HTTP server, through the public ``publish()`` — no mocks between the
callback and the wire:

- the PLAIN single-request branch (at or under the resumable threshold):
  the callback fires per read chunk and ends at ``sent == total`` (the
  train-merge zombie return at the end of ``_upload_directory_archive``
  silently dropped ``on_bytes`` here — this is the pin that would have
  caught it);
- the RESUMABLE chunked branch (over the threshold, shrunk here the same
  way test_hosted_resumable.py shrinks the chunk law): the callback fires
  per ACKNOWLEDGED chunk and ends at ``sent == total`` — above the
  threshold is exactly the multi-GB shape the progress feature exists for.
"""

import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from evolve import datasets as datasets_factory
from evolve.config import HostedClientConfig

from .test_hosted_resumable import make_server


@pytest.fixture()
def corpus(tmp_path):
    """A small publishable directory — a few KB, so the plain branch runs
    several read chunks yet the whole test stays instant."""
    tasks = tmp_path / 'tasks' / 'abc'
    tasks.mkdir(parents=True)
    (tasks / 'task.toml').write_text('schema_version = "1.1"\n')
    (tasks / 'filler.bin').write_bytes(b'x' * 8192)
    return str(tmp_path)


def make_plain_server():
    """A REAL minimal publish door: reads the whole multipart body, answers
    the classic 202."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: D102 — quiet
            pass

        def do_POST(self):
            length = int(self.headers.get('Content-Length', 0))
            self.rfile.read(length)
            payload = json.dumps(
                {'id': 'imp-1', 'status': 'QUEUED', 'name': 'prog-set', 'version': '0.1'}
            ).encode()
            self.send_response(202)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def publish_with_progress(port: int, directory: str):
    calls: 'list[tuple[int, int]]' = []
    config = HostedClientConfig(api_key='k', base_url=f'http://127.0.0.1:{port}')
    job = asyncio.run(
        datasets_factory(config).publish(
            directory=directory,
            name='prog-set',
            version='0.1',
            on_upload_progress=lambda sent, total: calls.append((sent, total)),
        )
    )
    return job, calls


def assert_progress_reached_total(calls):
    assert calls, 'on_upload_progress never fired'
    totals = {total for _, total in calls}
    assert len(totals) == 1, f'total_bytes must be constant, saw {totals}'
    total = totals.pop()
    assert total > 0
    sents = [sent for sent, _ in calls]
    assert sents == sorted(sents), 'sent_bytes must be non-decreasing'
    assert sents[-1] == total, 'the last call must report sent == total'


def test_plain_branch_fires_on_upload_progress(corpus):
    server = make_plain_server()
    try:
        job, calls = publish_with_progress(server.server_address[1], corpus)
        assert job.id == 'imp-1'
        assert_progress_reached_total(calls)
    finally:
        server.shutdown()


def test_resumable_branch_fires_on_upload_progress(corpus):
    # Shrink the threshold and the chunk law so a KB corpus rides the
    # session door in several chunks — the same module-global override
    # test_hosted_resumable.py uses (publish() and the loop read both names
    # from evolve.hosted at call time).
    hosted = sys.modules['evolve.hosted']
    original_threshold = hosted.RESUMABLE_UPLOAD_THRESHOLD_BYTES
    original_chunk = hosted.RESUMABLE_UPLOAD_CHUNK_BYTES
    hosted.RESUMABLE_UPLOAD_THRESHOLD_BYTES = 1
    hosted.RESUMABLE_UPLOAD_CHUNK_BYTES = 1024
    server, sessions = make_server({})
    try:
        job, calls = publish_with_progress(server.server_address[1], corpus)
        assert job.id == 'version-1'
        assert_progress_reached_total(calls)
        # Per ACKNOWLEDGED chunk: one call per PATCH the server landed.
        state = list(sessions.values())[0]
        assert len(calls) == len(state.received)
    finally:
        hosted.RESUMABLE_UPLOAD_THRESHOLD_BYTES = original_threshold
        hosted.RESUMABLE_UPLOAD_CHUNK_BYTES = original_chunk
        server.shutdown()
