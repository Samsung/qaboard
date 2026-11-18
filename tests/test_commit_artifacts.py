"""
Tests for qaboard/commit_artifacts.py: a commit's artifacts sent to the server by `qa save-artifacts`, and fetched
by the pods that run from them. The fake server answers like backend/api/commit_artifacts.py: change them together.
"""
import hashlib
import json
import os
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, unquote, urlsplit

from qaboard import commit_artifacts
from qaboard.commit_artifacts import ArtifactsError, ServerTooOld, bundle_hash, fetch, listing, read_marker, send

COMMIT = "0123456789abcdef0123456789abcdef01234567"
PROJECT = "group/repo/sub"


class FakeServer:
  """
  The commit's artifacts folder is `files` ({path in the repository: bytes}), executables in `modes`.
  GET /api/v1/commit/<commit>/artifacts lists what the manifests under sub/manifests/ list, and the manifests;
  PUT .../files/<path> checks X-Content-SHA256; GET /s/artifacts/<path> serves the files.
  """
  def __init__(self, subproject='sub', project=PROJECT):
    self.files = {}
    self.requests = []
    self.commits = []
    self.project = project
    self.corrupt = set()
    self.subproject = subproject
    server = self

    class Handler(BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass

      def reply(self, status, body):
        content = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

      def do_GET(self):
        url = urlsplit(self.path)
        server.requests.append(('GET', unquote(url.path), parse_qs(url.query)))
        if url.path.startswith('/s/artifacts/'):
          path = unquote(url.path[len('/s/artifacts/'):])
          if path not in server.files:
            return self.reply(404, b'not found')
          return self.reply(200, b'corrupted' if path in server.corrupt else server.files[path])
        if re.fullmatch(r'/api/v1/commit/[0-9a-f]{40}/artifacts', url.path) and parse_qs(url.query).get('project') == [server.project]:
          listed = server.listing()
          if not listed:
            return self.reply(404, {"error": "not sent", "reason": "not_uploaded"})
          return self.reply(200, {"files": listed, "hash": bundle_hash(listed), "url": "/s/artifacts", "subproject": server.subproject})
        self.reply(404, {"error": "?"})

      def do_POST(self):
        # the commit, before its artifacts (backend/api/commit.py)
        content = self.rfile.read(int(self.headers['Content-Length']))
        server.requests.append(('POST', self.path, {}))
        if self.path.rstrip('/') != '/api/v1/commit':
          return self.reply(404, {"error": "?"})
        server.commits.append(json.loads(content))
        self.reply(200, {"status": "OK"})

      def do_PUT(self):
        url = urlsplit(self.path)
        content = self.rfile.read(int(self.headers['Content-Length']))
        server.requests.append(('PUT', unquote(url.path), parse_qs(url.query)))
        match = re.match(r'/api/v1/commit/[0-9a-f]{40}/artifacts/files/', url.path)
        if not match or parse_qs(url.query).get('project') != [server.project]:
          return self.reply(404, {"error": "?"})
        prefix = match.group(0)
        if hashlib.sha256(content).hexdigest() != self.headers.get('X-Content-SHA256'):
          return self.reply(422, {"error": "digest", "reason": "digest_mismatch"})
        path = unquote(url.path[len(prefix):])
        server.files[path] = content
        self.reply(200, {"path": path, "size": len(content)})

    self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
    threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

  def listing(self):
    listed = {}
    for manifest, content in self.files.items():
      if not manifest.startswith(f'{self.subproject}/manifests/' if self.subproject else 'manifests/'):
        continue
      listed[manifest] = {"sha256": hashlib.sha256(content).hexdigest(), "size": len(content), "executable": False}
      for path, info in json.loads(content).items():
        if path in self.files:
          listed[path] = {"sha256": hashlib.sha256(self.files[path]).hexdigest(), "size": len(self.files[path]), "executable": bool(info.get('executable'))}
    return dict(sorted(listed.items()))

  def puts(self):
    return [path.split('/files/', 1)[1] for method, path, _ in self.requests if method == 'PUT']

  def downloads(self):
    return [path for method, path, _ in self.requests if method == 'GET' and path.startswith('/s/')]

  def close(self):
    self.httpd.shutdown()
    self.httpd.server_close()


def ResultsError_404():
  from qaboard.results import ResultsError
  return ResultsError("not found", status=404, body={"error": "Sorry, we could not find any data on commit"})


class ArtifactsTestCase(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = Path(tmp.name)
    self.repo = self.root / 'repo'
    self.repo.mkdir()
    previous = os.getcwd()
    os.chdir(self.repo)
    self.addCleanup(os.chdir, previous)
    for patch in (mock.patch.object(commit_artifacts, 'RETRY_DELAYS', (0.0, 0.0)), mock.patch.dict(os.environ, {'QABOARD_ARTIFACTS_CACHE': str(self.root / 'cache')})):
      patch.start()
      self.addCleanup(patch.stop)
    self.server = FakeServer()
    self.addCleanup(self.server.close)

  def write(self, path, content, executable=False):
    file = self.repo / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(content)
    file.chmod(0o755 if executable else 0o644)

  def send(self, groups):
    known = listing(self.server.url, PROJECT, COMMIT, token='token')
    return send(self.server.url, PROJECT, COMMIT, {name: (Path('sub/manifests') / f'{name}.json', paths) for name, paths in groups.items()}, known, token='token')


class TestSend(ArtifactsTestCase):
  def test_sends_the_files_then_their_manifest(self):
    self.write('qaboard.yaml', b'project: {}')
    self.write('sub/qaboard.yaml', b'inputs: {}')
    self.write('build/tool', b'\x7fELF', executable=True)
    summary = self.send({'__qaboard.yaml': ['qaboard.yaml', 'sub/qaboard.yaml'], 'binaries': ['build/tool']})
    self.assertEqual(summary, {"sent": 3, "skipped": 0, "bytes": len(b'project: {}inputs: {}\x7fELF')})
    # a file in two groups is sent once
    self.assertEqual(self.send({'a': ['qaboard.yaml'], 'b': ['qaboard.yaml']})["sent"], 0)
    puts = self.server.puts()
    self.assertLess(puts.index('qaboard.yaml'), puts.index('sub/manifests/__qaboard.yaml.json'))
    self.assertEqual(self.server.files['build/tool'], b'\x7fELF')
    manifest = json.loads(self.server.files['sub/manifests/binaries.json'])
    self.assertEqual(manifest, {'build/tool': {'sha256': hashlib.sha256(b'\x7fELF').hexdigest(), 'st_size': 4, 'executable': True}})

  def test_files_the_server_has_arent_sent_again(self):
    self.write('qaboard.yaml', b'a')
    self.write('build/tool', b'b')
    self.send({'all': ['qaboard.yaml', 'build/tool']})
    self.server.requests.clear()
    # nothing changed: nothing sent, not even the manifest
    self.assertEqual(self.send({'all': ['qaboard.yaml', 'build/tool']})["sent"], 0)
    self.assertEqual(self.server.puts(), [])
    self.write('build/tool', b'changed')
    summary = self.send({'all': ['qaboard.yaml', 'build/tool']})
    self.assertEqual(self.server.puts(), ['build/tool', 'sub/manifests/all.json'])
    self.assertEqual((summary["sent"], summary["skipped"]), (1, 1))

  def test_manifests_grow(self):
    # like in a shared storage: `qa save-artifacts binaries` after the build, `qa save-artifacts` later
    self.write('a', b'a')
    self.write('b', b'b')
    self.send({'g': ['a']})
    self.send({'g': ['b']})
    self.assertEqual(set(json.loads(self.server.files['sub/manifests/g.json'])), {'a', 'b'})

  def test_refusals_say_why(self):
    self.write('a', b'a')
    with mock.patch.object(commit_artifacts, 'sha256_of', return_value='0' * 64):
      # the server's own words, not the request
      with self.assertRaisesRegex(ArtifactsError, r'^QA-Board refused a: digest$'):
        self.send({'g': ['a']})

  def test_errors_for_people(self):
    from qaboard.results import ResultsError
    explain = commit_artifacts.explain
    self.assertIn("larger than QA-Board accepts", explain(ResultsError("<html>413</html>", status=413), "http://qa", "build/tool", 3 * 1024**2))
    self.assertEqual(explain(ResultsError("<html>502</html>", status=502), "http://qa"), "QA-Board at http://qa answered 502, not as its API does: check QABOARD_URL.")
    self.assertEqual(explain(ResultsError("...", status=400, body={"error": "Nope."}), "http://qa"), "Nope.")
    down = ResultsError("Could not reach http://qa: HTTPConnectionPool(host='qa', port=80): Max retries exceeded (Caused by NewConnectionError(\"...: [Errno 111] Connection refused\"))")
    self.assertEqual(explain(down, "http://qa"), "Could not reach QA-Board at http://qa (connection refused): check QABOARD_URL, and that the server runs.")

  def test_servers_that_dont_take_artifacts(self):
    # older servers answer GET /commit/<id>/artifacts with the commit's results, or 404 without a reason
    for answer in ({"id": 1, "batches": {}}, ResultsError_404()):
      with mock.patch.object(commit_artifacts, '_request', side_effect=[answer] if isinstance(answer, Exception) else None, return_value=answer):
        with self.assertRaises(ServerTooOld):
          listing(self.server.url, PROJECT, COMMIT)


class TestFetch(ArtifactsTestCase):
  def setUp(self):
    super().setUp()
    self.write('qaboard.yaml', b'project: {}')
    self.write('sub/qaboard.yaml', b'inputs: {}')
    self.write('build/tool', b'#!/bin/sh\necho tool\n', executable=True)
    self.send({'__qaboard.yaml': ['qaboard.yaml', 'sub/qaboard.yaml'], 'binaries': ['build/tool']})
    self.server.requests.clear()

  def test_fetches_once_per_cache(self):
    folder = fetch(self.server.url, PROJECT, COMMIT)
    self.assertTrue(folder.is_relative_to(self.root / 'cache'))
    self.assertEqual((folder / 'sub/qaboard.yaml').read_bytes(), b'inputs: {}')
    self.assertTrue(os.access(folder / 'build/tool', os.X_OK))
    self.assertFalse(os.access(folder / 'qaboard.yaml', os.X_OK))
    self.assertTrue((folder / 'sub/manifests/binaries.json').is_file())
    marker = read_marker(folder / 'sub')
    self.assertEqual((marker['project'], marker['commit'], marker['subproject'], marker['root']), (PROJECT, COMMIT, 'sub', str(folder)))
    self.assertEqual(len(self.server.downloads()), 5)
    # again: only the list
    self.assertEqual(fetch(self.server.url, PROJECT, COMMIT), folder)
    self.assertEqual(len(self.server.downloads()), 5)
    # nothing left behind
    self.assertEqual([p.name for p in (self.root / 'cache').iterdir()], [folder.name])

  def test_new_artifacts_are_fetched_again(self):
    first = fetch(self.server.url, PROJECT, COMMIT)
    self.write('build/tool', b'v2', executable=True)
    self.send({'binaries': ['build/tool']})
    second = fetch(self.server.url, PROJECT, COMMIT)
    self.assertNotEqual(first, second)
    self.assertEqual((second / 'build/tool').read_bytes(), b'v2')

  def test_downloads_are_checked(self):
    self.server.corrupt.add('build/tool')
    with self.assertRaisesRegex(ArtifactsError, "doesn't have the SHA-256"):
      fetch(self.server.url, PROJECT, COMMIT)
    self.assertEqual(list((self.root / 'cache').iterdir()), [])

  def test_without_artifacts(self):
    server = FakeServer()
    self.addCleanup(server.close)
    with self.assertRaisesRegex(ArtifactsError, 'qa save-artifacts'):
      fetch(server.url, PROJECT, COMMIT)

  def test_listed_paths_stay_in_the_cache(self):
    for path in ('../escape', '/etc/passwd', 'a/../../b', 'a\\b'):
      with mock.patch.object(commit_artifacts, 'listing', return_value={"files": {path: {"sha256": "0" * 64, "size": 1}}, "hash": bundle_hash({path: {"sha256": "0" * 64}}), "url": "/s/x"}):
        with self.assertRaisesRegex(ArtifactsError, 'outside'):
          fetch(self.server.url, PROJECT, COMMIT)


if __name__ == '__main__':
  unittest.main()
