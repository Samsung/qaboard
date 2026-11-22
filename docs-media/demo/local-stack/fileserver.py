#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Stands in for the nginx proxy's /s/ locations (services/nginx/snippets/qaboard-files.conf), without nginx:
serves the runs' files at /s/<absolute path>, with Range requests (audio, logs), and sends folder listings asked as
JSON to the backend (GET /s/<folder>/, backend/api/files.py), like nginx does with uwsgi_pass.

Only files under the roots given with --root are served. No access checks (nginx asks /api/v1/files/authorize):
fine for a demo where every project is public.

  uv run fileserver.py --port 5151 --backend http://127.0.0.1:5152 --root /mnt/qaboard
"""
import argparse
import mimetypes
import os
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

mimetypes.add_type('application/json', '.json')
mimetypes.add_type('application/x-ndjson', '.jsonl')
mimetypes.add_type('audio/wav', '.wav')
mimetypes.add_type('text/plain', '.log')


class Handler(BaseHTTPRequestHandler):
  roots: list = []
  backend: str = ''
  protocol_version = 'HTTP/1.1'

  def log_message(self, fmt, *args):  # quieter
    if os.environ.get('FILESERVER_VERBOSE'):
      super().log_message(fmt, *args)

  def cors(self):
    self.send_header('Access-Control-Allow-Origin', '*')
    self.send_header('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type')
    self.send_header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    self.send_header('X-Content-Type-Options', 'nosniff')

  def error(self, status, message):
    body = message.encode()
    self.send_response(status)
    self.cors()
    self.send_header('Content-Type', 'text/plain; charset=utf-8')
    self.send_header('Content-Length', str(len(body)))
    self.end_headers()
    if self.command != 'HEAD':
      self.wfile.write(body)

  def do_OPTIONS(self):
    self.send_response(204)
    self.cors()
    self.send_header('Content-Length', '0')
    self.end_headers()

  def do_HEAD(self):
    self.do_GET()

  def proxy_listing(self):
    headers = {k: v for k, v in self.headers.items() if k.lower() in ('accept', 'cookie', 'authorization')}
    request = urllib.request.Request(self.backend + self.path, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
      response = opener.open(request, timeout=30)
      status, body, content_type = response.status, response.read(), response.headers.get('Content-Type', 'application/json')
    except urllib.error.HTTPError as e:
      status, body, content_type = e.code, e.read(), e.headers.get('Content-Type', 'application/json')
    except Exception as e:  # backend down
      return self.error(502, f"backend: {e}")
    self.send_response(status)
    self.cors()
    self.send_header('Content-Type', content_type)
    self.send_header('Content-Length', str(len(body)))
    self.send_header('Vary', 'Accept')
    self.end_headers()
    if self.command != 'HEAD':
      self.wfile.write(body)

  def do_GET(self):
    url = urllib.parse.urlsplit(self.path)
    if not url.path.startswith('/s/'):
      return self.error(404, "Only /s/ is served here")
    path = urllib.parse.unquote(url.path[2:])
    if '/.qaboard-upload-' in path:
      return self.error(404, "Not found")
    real = Path(os.path.realpath(path))
    if not any(real == root or root in real.parents for root in self.roots):
      return self.error(403, f"{path} is outside the served roots")
    if real.is_dir():
      if 'application/json' in self.headers.get('Accept', '') or 'view=nginx' not in url.query:
        return self.proxy_listing()
    if not real.is_file():
      return self.error(404, "Not found")
    size = real.stat().st_size
    start, end = 0, size - 1
    status = 200
    range_header = self.headers.get('Range')
    if range_header:
      match = re.match(r'bytes=(\d*)-(\d*)$', range_header.strip())
      if match and (match.group(1) or match.group(2)):
        if match.group(1):
          start = int(match.group(1))
          end = int(match.group(2)) if match.group(2) else size - 1
        else:  # the last N bytes
          start = max(0, size - int(match.group(2)))
        end = min(end, size - 1)
        if start > end or start >= size:
          self.send_response(416)
          self.cors()
          self.send_header('Content-Range', f'bytes */{size}')
          self.send_header('Content-Length', '0')
          self.end_headers()
          return
        status = 206
    content_type = mimetypes.guess_type(real.name)[0] or 'application/octet-stream'
    if content_type.startswith('text/') or content_type in ('application/json', 'application/x-ndjson'):
      content_type += '; charset=utf-8'
    self.send_response(status)
    self.cors()
    self.send_header('Content-Type', content_type)
    self.send_header('Accept-Ranges', 'bytes')
    self.send_header('Content-Length', str(end - start + 1))
    self.send_header('Cache-Control', 'no-cache')
    self.send_header('Last-Modified', self.date_time_string(int(real.stat().st_mtime)))
    if status == 206:
      self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
    self.end_headers()
    if self.command == 'HEAD':
      return
    with real.open('rb') as f:
      f.seek(start)
      remaining = end - start + 1
      while remaining > 0:
        chunk = f.read(min(1 << 20, remaining))
        if not chunk:
          break
        try:
          self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
          return
        remaining -= len(chunk)


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--port', type=int, default=5151)
  parser.add_argument('--host', default='127.0.0.1')
  parser.add_argument('--backend', default='http://127.0.0.1:5152')
  parser.add_argument('--root', action='append', required=True)
  args = parser.parse_args()
  Handler.roots = [Path(os.path.realpath(r)) for r in args.root]
  Handler.backend = args.backend.rstrip('/')
  server = ThreadingHTTPServer((args.host, args.port), Handler)
  server.daemon_threads = True
  print(f"Serving /s/ for {', '.join(map(str, Handler.roots))} on http://{args.host}:{args.port}", flush=True)
  server.serve_forever()


if __name__ == '__main__':
  main()
