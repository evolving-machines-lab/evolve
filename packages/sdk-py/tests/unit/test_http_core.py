"""The shared HTTP core (evolve._http): one opener, redirects refused.

urllib's default opener replays a redirected request at whatever Location the
server names — original headers included, Authorization included, across
hosts. These tests run a REAL local redirecting server, because mocking the
opener would mock away the very behavior under test: the redirect must die at
the client, and the destination must never see the bearer key.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from evolve import _http


class _Recorder(BaseHTTPRequestHandler):
    """Records every request (path + headers) on the server instance."""

    def _record(self):
        self.server.seen.append(
            {'path': self.path, 'authorization': self.headers.get('Authorization')}
        )

    def do_GET(self):
        self._record()
        route = self.server.routes.get(self.path, {'status': 200, 'body': b'{"ok": true}'})
        self.send_response(route['status'])
        for name, value in route.get('headers', {}).items():
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(route.get('body', b''))))
        self.end_headers()
        self.wfile.write(route.get('body', b''))

    do_POST = do_GET

    def log_message(self, *args):
        pass


@pytest.fixture
def server_pair():
    """Two live servers: `origin` (may redirect) and `target` (must stay cold)."""
    servers = []
    for _ in range(2):
        server = ThreadingHTTPServer(('127.0.0.1', 0), _Recorder)
        server.seen = []
        server.routes = {}
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    try:
        yield servers
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


def _url(server, path):
    return f'http://127.0.0.1:{server.server_address[1]}{path}'


@pytest.mark.parametrize('status', [301, 302, 303, 307, 308])
def test_redirects_are_refused_and_the_key_never_moves(server_pair, status):
    origin, target = server_pair
    origin.routes['/api/thing'] = {
        'status': status,
        'headers': {'Location': _url(target, '/stolen')},
        'body': b'',
    }

    with pytest.raises(RuntimeError, match=rf'request failed \({status}\)'):
        _http.request_json(
            _url(origin, '/api/thing'),
            api_key='ev_secret',
            error_prefix='Core test',
        )

    assert origin.seen[0]['authorization'] == 'Bearer ev_secret'
    # The whole point: the Location host never sees a request, so it can never
    # see the Authorization header urllib would have replayed at it.
    assert target.seen == []


def test_request_json_happy_path_and_empty_body(server_pair):
    origin, _ = server_pair
    origin.routes['/api/list'] = {'status': 200, 'body': json.dumps({'items': [1, 2]}).encode()}
    origin.routes['/api/empty'] = {'status': 200, 'body': b''}

    result = _http.request_json(_url(origin, '/api/list'), api_key='k', error_prefix='Core test')
    assert result == {'items': [1, 2]}
    assert origin.seen[0]['authorization'] == 'Bearer k'

    assert _http.request_json(_url(origin, '/api/empty'), api_key='k', error_prefix='Core test') == {}


def test_request_json_error_carries_prefix_status_and_detail(server_pair):
    origin, _ = server_pair
    origin.routes['/api/boom'] = {'status': 403, 'body': b'nope'}

    with pytest.raises(RuntimeError, match=r'Core test request failed \(403\): nope'):
        _http.request_json(_url(origin, '/api/boom'), api_key='k', error_prefix='Core test')
