"""
Answers the requests that QA-Board's backend sends to the demo world's hosts (*.kitefin.example), e.g. the webhook
integrations of the example projects ("Send to the tuning bench"). Started by docs-media/compose.demo.yml.

Every request gets a 200 with a small JSON: what QA-Board shows as the webhook's status, with a link to the "job".
HTTP on port 80, HTTPS on 443 with a self-signed certificate (the backend doesn't verify webhooks' certificates).
"""
import json
import ssl
import hashlib
import threading
import subprocess
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
  server_version = "kitefin-stub"

  def answer(self):
    length = int(self.headers.get('Content-Length') or 0)
    body = self.rfile.read(length) if length else b''
    if self.path == '/health':
      return self.reply({"status": "ok"})
    host = (self.headers.get('Host') or 'kitefin.example').split(':')[0]
    # The same request gets the same job id
    job_id = hashlib.sha1(self.command.encode() + self.path.encode() + body).hexdigest()[:8]
    self.reply({
      "status": "queued",
      "id": job_id,
      "url": f"https://{host}/jobs/{job_id}",
      "message": f"Queued on {host}",
    })

  def reply(self, data):
    payload = json.dumps(data).encode()
    self.send_response(200)
    self.send_header('Content-Type', 'application/json')
    self.send_header('Content-Length', str(len(payload)))
    self.end_headers()
    if self.command != 'HEAD':
      self.wfile.write(payload)

  do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = answer

  def log_message(self, format, *args):
    print(f"{self.headers.get('Host')} {format % args}", flush=True)


def https_server():
  cert, key = Path('/tmp/stub.crt'), Path('/tmp/stub.key')
  subprocess.run([
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
    '-subj', '/CN=*.kitefin.example', '-keyout', str(key), '-out', str(cert),
  ], check=True, capture_output=True)
  server = ThreadingHTTPServer(('', 443), Handler)
  context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
  context.load_cert_chain(cert, key)
  server.socket = context.wrap_socket(server.socket, server_side=True)
  return server


if __name__ == '__main__':
  threading.Thread(target=https_server().serve_forever, daemon=True).start()
  ThreadingHTTPServer(('', 80), Handler).serve_forever()
