"""
Tests for `qa restore` (qaboard/restore.py): a branch with the code a run ran, from what it recorded.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(*args, cwd):
  env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.com'}
  return subprocess.run(['git', *args], cwd=cwd, env=env, check=True, encoding='utf8', capture_output=True).stdout.strip()


class Server:
  """Serves GET /api/v1/output/<id> and the run's files under /s/run/"""
  def __init__(self, output, files):
    server = self

    class Handler(BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass

      def do_GET(self):
        if self.path.rstrip('/') == f"/api/v1/output/{output['id']}":
          body = json.dumps(output).encode()
        elif self.path.startswith('/s/run/') and self.path[len('/s/run/'):] in files:
          body = files[self.path[len('/s/run/'):]]
        else:
          self.send_response(404)
          self.end_headers()
          return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
    threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
    server.output = output

  def close(self):
    self.httpd.shutdown()
    self.httpd.server_close()


class TestRestore(unittest.TestCase):
  def setUp(self):
    from qaboard import local_changes as lc
    self.tmp = Path(tempfile.mkdtemp())
    self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
    # the repository where the run ran, pushed
    self.origin = self.tmp / 'origin.git'
    git('init', '-q', '--bare', '-b', 'main', str(self.origin), cwd=self.tmp)
    self.work = self.tmp / 'work'
    git('clone', '-q', str(self.origin), str(self.work), cwd=self.tmp)
    git('checkout', '-q', '-b', 'main', cwd=self.work)
    (self.work / 'train.py').write_text("lr = 0.1\n")
    git('add', '.', cwd=self.work)
    git('commit', '-q', '-m', 'first', cwd=self.work)
    git('push', '-q', '-u', 'origin', 'main', cwd=self.work)
    self.pushed = git('rev-parse', 'HEAD', cwd=self.work)
    self.lc = lc

  def record(self, run_id=42):
    """What a run in the working tree recorded"""
    captured = self.lc.capture(self.work)
    files = {}
    for content, key in ((captured.patch, 'patch'), (captured.unpushed, 'unpushed')):
      if content is not None:
        files[captured.state[key]['path']] = content
    output = {'id': run_id, 'output_dir_url': '/s/run', 'data': {'local_changes': captured.state}, 'test_input_path': 'a.jpg', 'configurations': ['base']}
    server = Server(output, files)
    self.addCleanup(server.close)
    return server, captured

  def clone(self):
    clone = self.tmp / 'clone'
    git('clone', '-q', str(self.origin), str(clone), cwd=self.tmp)
    return clone

  def qa(self, *args, cwd):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI', 'GITHUB_'))}
    env.update({'PYTHONPATH': str(ROOT), 'HOME': str(self.tmp), 'XDG_CONFIG_HOME': str(self.tmp), 'QABOARD_IGNORE_SITE': '1',
                'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.com'})
    return subprocess.run([sys.executable, '-m', 'qaboard', 'restore', *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=120)

  def test_uncommitted_changes(self):
    (self.work / 'train.py').write_text("lr = 0.2\n")
    (self.work / 'augment.py').write_text("flip = True\n")
    server, _ = self.record()
    clone = self.clone()
    out = self.qa('42', '--server', server.url, cwd=clone)
    self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
    self.assertIn('On the branch qa-restore/42', out.stdout)
    self.assertEqual(git('rev-parse', '--abbrev-ref', 'HEAD', cwd=clone), 'qa-restore/42')
    self.assertEqual(git('rev-parse', 'HEAD', cwd=clone), self.pushed)
    self.assertEqual((clone / 'train.py').read_text(), "lr = 0.2\n")
    self.assertEqual((clone / 'augment.py').read_text(), "flip = True\n")
    # new files show in git diff with the others
    self.assertIn('augment.py', git('diff', '--stat', cwd=clone))
    self.assertIn('read it before you run it', out.stdout)
    self.assertIn('New files: augment.py', out.stdout)

  def test_unpushed_commits(self):
    (self.work / 'train.py').write_text("lr = 0.3\n")
    git('commit', '-q', '-am', 'local', cwd=self.work)
    (self.work / 'train.py').write_text("lr = 0.4\n")
    server, captured = self.record()
    self.assertIs(captured.state['pushed'], False)
    clone = self.clone()
    out = self.qa(f"{server.url}/group/repo/commit/{captured.state['head']}?filter=id%3A42", cwd=clone)
    self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
    self.assertEqual(git('rev-parse', 'HEAD~1', cwd=clone), self.pushed)
    self.assertEqual(git('log', '-1', '--format=%an', cwd=clone), 'qa restore')
    self.assertEqual(git('show', 'HEAD:train.py', cwd=clone), "lr = 0.3")
    self.assertEqual((clone / 'train.py').read_text(), "lr = 0.4\n")

  def test_refuses_a_dirty_tree(self):
    (self.work / 'train.py').write_text("lr = 0.2\n")
    server, _ = self.record()
    clone = self.clone()
    (clone / 'train.py').write_text("mine\n")
    out = self.qa('42', '--server', server.url, cwd=clone)
    self.assertEqual(out.returncode, 1)
    self.assertIn('uncommitted changes', out.stderr)
    self.assertEqual((clone / 'train.py').read_text(), "mine\n")

  def test_download(self):
    (self.work / 'train.py').write_text("lr = 0.2\n")
    server, captured = self.record()
    folder = self.tmp / 'elsewhere'
    folder.mkdir()
    out = self.qa('42', '--server', server.url, '--download', cwd=folder)
    self.assertEqual(out.returncode, 0, out.stderr)
    self.assertEqual((folder / 'run-42-local-changes.patch').read_bytes(), captured.patch)
    self.assertIn(f"git checkout {self.pushed[:12]} && git apply run-42-local-changes.patch", out.stdout)

  def test_runs_that_didnt_save_their_patch(self):
    (self.work / 'train.py').write_text("lr = 0.2\n")
    captured = self.lc.capture(self.work, self.lc.Settings(max_patch_bytes=10))
    self.assertEqual(captured.state['patch']['omitted'], 'too_large')
    server = Server({'id': 42, 'output_dir_url': '/s/run', 'data': {'local_changes': captured.state}}, {})
    self.addCleanup(server.close)
    clone = self.clone()
    out = self.qa('42', '--server', server.url, cwd=clone)
    self.assertEqual(out.returncode, 1, out.stderr)
    self.assertIn("didn't save its patch: it was too large", out.stderr)
    self.assertEqual(git('rev-parse', '--abbrev-ref', 'HEAD', cwd=clone), 'main')

  def test_runs_without_local_changes(self):
    output = {'id': 7, 'output_dir_url': '/s/run', 'data': {'ci': True}}
    server = Server(output, {})
    self.addCleanup(server.close)
    out = self.qa('7', '--server', server.url, cwd=self.clone())
    self.assertEqual(out.returncode, 1)
    self.assertIn("it ran in CI", out.stderr)


class TestPlan(unittest.TestCase):
  def test_plans(self):
    from qaboard.restore import plan, parse_run
    has = lambda known: (lambda sha: sha in known)
    h, b = 'a' * 40, 'b' * 40
    changes = {'head': h, 'base': b, 'pushed': False, 'unpushed': {'path': 'x'}}
    self.assertEqual(plan(changes, has({h, b})), (h, False, None))
    self.assertEqual(plan(changes, has({b})), (b, True, None))
    self.assertIn('git fetch', plan(changes, has(set()))[2])
    self.assertIn('never pushed', plan({'head': h, 'pushed': False}, has(set()))[2])
    # only commit ids: not your HEAD, a branch, or an option
    for head in ('HEAD', 'main', '--orphan'):
      self.assertIsNone(plan({'head': head}, lambda sha: True)[0])

  def test_what_runs_say_is_printed_safely(self):
    from qaboard.restore import _safe, _glob_literal, parse_run
    self.assertEqual(_safe("a\x1b]52;c;ZXZp\x07b"), "a]52;c;ZXZpb")
    self.assertEqual(_glob_literal("*"), "[*]")
    self.assertEqual(parse_run('12', None), (12, None))
    self.assertEqual(parse_run('https://qa.example.com/a/b/commit/c?batch=x&filter=id:12', None), (12, 'https://qa.example.com'))


if __name__ == '__main__':
  unittest.main()
