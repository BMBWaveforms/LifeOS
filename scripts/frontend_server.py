"""Local frontend-only development server; /api and /health reverse proxy to API."""
import argparse
import http.client
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    backend_port = 8781
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'frontend'), **kwargs)
    def log_message(self, *args):
        pass
    def proxy(self):
        if self.path.startswith('/api/') or self.path == '/health':
            size = int(self.headers.get('Content-Length', '0'))
            if size > 20000:
                self.send_error(413)
                return True
            connection = http.client.HTTPConnection('127.0.0.1', self.backend_port, timeout=300)
            headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'connection', 'transfer-encoding')}
            try:
                connection.request(self.command, self.path, self.rfile.read(size), headers)
                response = connection.getresponse()
                body = response.read()
                self.send_response(response.status)
                for k, v in response.getheaders():
                    if k.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (OSError, http.client.HTTPException):
                self.send_error(502, 'Backend unavailable')
            finally:
                connection.close()
            return True
        return False
    def do_GET(self):
        if not self.proxy():
            # Serve only frontend artifacts, never project root/config/runtime.
            super().do_GET()
    def do_POST(self):
        if not self.proxy():
            self.send_error(404)

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=8780)
    p.add_argument('--backend-port', type=int, default=8781)
    a = p.parse_args()
    Handler.backend_port = a.backend_port
    ThreadingHTTPServer(('127.0.0.1', a.port), Handler).serve_forever()
