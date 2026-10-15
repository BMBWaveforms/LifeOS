"""Exercise actual local HTTP handler behavior without opening network sockets."""
import http.client
import importlib.util
import io
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('horizon_frontend_server', ROOT / 'scripts/frontend_server.py')
frontend_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frontend_server)


class LocalSocket:
    def __init__(self, incoming):
        self.incoming = io.BytesIO(incoming)
        self.outgoing = io.BytesIO()

    def makefile(self, *args):
        return self.incoming

    def sendall(self, data):
        self.outgoing.write(data)


@pytest.fixture
def proxy(monkeypatch):
    received = []

    class BackendConnection:
        def __init__(self, *args, **kwargs):
            pass

        def request(self, method, path, body, headers):
            received.append((path, len(body)))
            self.body = body

        def getresponse(self):
            payload = json.dumps({'accepted': len(self.body)}).encode()

            class Response:
                status = 200
                def getheaders(self):
                    return [('Content-Type', 'application/json')]
                def read(self):
                    return payload
            return Response()

        def close(self):
            pass

    monkeypatch.setattr(frontend_server.http.client, 'HTTPConnection', BackendConnection)

    def request(path, body=b'', declared_size=None, method='POST'):
        size = len(body) if declared_size is None else declared_size
        raw = f'{method} {path} HTTP/1.0\r\nContent-Length: {size}\r\n\r\n'.encode() + body
        socket = LocalSocket(raw)
        frontend_server.Handler(socket, ('127.0.0.1', 0), None)
        response = http.client.HTTPResponse(LocalSocket(socket.outgoing.getvalue()))
        response.begin()
        return response

    return request, received


@pytest.mark.parametrize(('path', 'limit'), [
    ('/api/prompt-tests', 200000),
    ('/api/eval/datasets', 2000000),
    ('/api/prompts/versions', 2000000),
    ('/api/prompts/import', 2000000),
    ('/api/run', 20000),
])
def test_route_body_limit_accepts_exactly_the_limit_and_rejects_one_more(proxy, path, limit):
    request, received = proxy
    accepted = request(path, body=b'x' * limit)
    assert accepted.status == 200
    assert json.loads(accepted.read()) == {'accepted': limit}
    assert received == [(path, limit)]
    # Rejecting must happen from the declared size, without reading or forwarding.
    rejected = request(path, declared_size=limit + 1)
    assert rejected.status == 413
    assert received == [(path, limit)]


def test_local_root_serves_modules_with_javascript_mime_and_has_no_old_product_route(proxy):
    request, _ = proxy
    response = request('/app.mjs', method='GET')
    assert response.status == 200
    assert response.getheader('Content-Type') == 'application/javascript'
    assert b'./memory-topics.mjs' in response.read()
    response = request('/horizon/', method='GET')
    assert response.status == 404
