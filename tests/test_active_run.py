"""
Tests for qaboard/active_run.py: runs created from code with `qaboard.start_run()`, without `qa run`.

Each test runs a script like a user's, in a temporary project, against a small HTTP server that answers like
QA-Board and records what it gets: what is tested is what the server and the storage see.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class FakeServer:
  """Answers POST /api/v1/output/ and PATCH /api/v1/output/<id>/progress, and keeps the requests."""
  def __init__(self, progress_status=200, output_status=200, output_error=None, port=0):
    self.requests = []
    server = self

    class Handler(BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass

      def answer(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

      def handle_request(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        server.requests.append((self.command, self.path, body, dict(self.headers)))
        if self.path.rstrip('/') == '/api/v1/output':
          if output_status != 200:
            return self.answer(output_status, output_error or {'error': 'no'})
          return self.answer(200, {'id': 42})
        if self.path.endswith('/progress'):
          return self.answer(progress_status, {'id': 42} if progress_status == 200 else {'error': 'not found'})
        self.answer(404, {'error': 'not found'})

      do_POST = do_PATCH = do_GET = handle_request

    self.httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
    threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

  def close(self):
    self.httpd.shutdown()
    self.httpd.server_close()

  def outputs(self):
    return [body for method, path, body, _ in self.requests if method == 'POST' and path.rstrip('/') == '/api/v1/output']

  def progress(self):
    return [body for method, path, body, _ in self.requests if method == 'PATCH' and path.endswith('/42/progress')]


def git(cwd, *args):
  return subprocess.run(['git', '-c', 'user.email=alice@example.com', '-c', 'user.name=alice', *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


TRAINING = """
import sys
import qaboard as qb
from qaboard import Metric

with qb.start_run(input="train/coco-mini", configs=["resnet50", {"lr": 0.001}], batch="lr-sweep", summary={"val/loss": "min"}) as run:
  run.log_params({"optimizer": "adamw"})
  for step in range(100):
    run.log({"train": {"loss": 1 / (1 + step)}, "lr": 0.001}, step=step)
    if step % 25 == 0:
      run.log({"val/loss": Metric(0.5 if step == 25 else 1.0, smaller_is_better=True)}, step=step)
  run.log_metrics({"mAP": Metric(0.41, smaller_is_better=False, target=0.4)})
  run.log_artifact("checkpoints/last.pt", b"weights")
  (run.output_dir / "model.onnx").write_bytes(b"model")
  print("training done")
"""


class ActiveRunTestCase(unittest.TestCase):
  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    tmp = Path(self.tmp.name).resolve()
    self.project, self.storage, self.home = tmp / 'detector', tmp / 'storage', tmp / 'home'
    for directory in (self.project, self.storage, self.home):
      directory.mkdir()
    (self.project / 'qaboard.yaml').write_text(f"project:\n  name: kitefin/detector\n  url: git@example.com:kitefin/detector.git\nstorage: {self.storage}\n")
    (self.project / 'train.py').write_text(TRAINING)
    git(self.project, 'init', '-q', '.')
    git(self.project, 'add', '.')
    git(self.project, 'commit', '-q', '-m', 'Train the detector')
    self.commit = git(self.project, 'rev-parse', 'HEAD')

  def server(self, **options):
    server = FakeServer(**options)
    self.addCleanup(server.close)
    return server

  def python(self, script='train.py', code=None, cwd=None, server=None, **env):
    """Runs a script of the project (or `code`), like a user outside the CI"""
    from qaboard.config import ci_env_variables
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI_', 'GITHUB_')) and k not in ci_env_variables}
    environ.update({
      'PYTHONPATH': str(ROOT), 'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home), 'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice',
      **({'QABOARD_URL': server.url if isinstance(server, FakeServer) else server} if server else {}),
      **env,
    })
    args = [sys.executable, '-c', code] if code is not None else [sys.executable, script]
    return subprocess.run(args, cwd=cwd or self.project, env=environ, capture_output=True, text=True, timeout=120)

  def shared_dir(self, batch='@alice| lr-sweep'):
    from qaboard.conventions import run_dir_in_commit
    relative = run_dir_in_commit(batch, 'linux' if os.name != 'nt' else 'windows', ['resnet50', {'lr': 0.001}], {}, 'train/coco-mini', Path('.'), {})
    return self.storage / 'kitefin/detector' / self.commit[:2] / self.commit[2:16] / relative


class TestSharedRuns(ActiveRunTestCase):
  def test_a_training_shows_like_a_qa_run(self):
    server = self.server()
    result = self.python(server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn(f"results: {server.url}/kitefin/detector/commit/{self.commit}?batch=%40alice%7C+lr-sweep&filter=id%3A42%24", result.stderr)
    started, *_, finished = server.outputs()
    run_dir = self.shared_dir()

    # what `qa --share --label lr-sweep run` sends (backend/api/outputs.py:new_output_webhook)
    for body in (started, finished):
      self.assertEqual(body['project'], 'kitefin/detector')
      self.assertEqual(body['commit_sha'], self.commit)
      self.assertEqual(body['commit_message'].strip(), 'Train the detector')
      self.assertEqual(body['batch_label'], '@alice| lr-sweep')  # outside the CI, people's runs go to their own batch
      self.assertEqual(body['job_type'], 'local')
      self.assertEqual(body['user'], 'alice')
      self.assertEqual((body['input_path'], body['database']), ('train/coco-mini', '/'))  # like qa, without inputs.database in qaboard.yaml
      self.assertEqual((body['configurations'], body['extra_parameters']), (['resnet50', {'lr': 0.001}], {}))
      self.assertNotIn('configuration', body)  # the server would parse the legacy text instead of the list
      self.assertEqual(body['output_directory'], str(run_dir))
      self.assertEqual(body['qaboard_config']['project']['name'], 'kitefin/detector')
      self.assertEqual(body['data']['params'], {'optimizer': 'adamw'} if body is finished else {})
      self.assertEqual(body['data']['sdk']['script'], 'train.py')
    self.assertEqual((started['is_pending'], started['is_running']), (True, True))
    self.assertEqual((finished['is_pending'], finished['is_running'], finished['is_failed']), (False, False, False))

    # the series' summaries (their last value, the minimum where asked) and the metrics logged
    metrics = finished['metrics']
    self.assertEqual({k: metrics[k] for k in ('train/loss', 'lr', 'val/loss', 'mAP', 'is_failed')},
                     {'train/loss': 0.01, 'lr': 0.001, 'val/loss': 0.5, 'mAP': 0.41, 'is_failed': False})
    self.assertGreaterEqual(metrics['compute_time'], 0)
    self.assertEqual(finished['metrics_definitions']['mAP'], {'smaller_is_better': False, 'target': 0.4})
    self.assertEqual(finished['metrics_definitions']['val/loss'], {'smaller_is_better': True})
    self.assertGreater(finished['data']['storage'], 0)

    # the same files as a `qa run`, and the series
    files = {p.relative_to(run_dir).as_posix() for p in run_dir.rglob('*') if p.is_file()}
    self.assertEqual(files, {'run.json', 'metrics.json', 'metrics_definitions.json', 'manifest.outputs.json', 'log.txt',
                             'series.jsonl', 'series.json', 'checkpoints/last.pt', 'model.onnx'})
    self.assertEqual(json.loads((run_dir / 'metrics.json').read_text()), metrics)
    self.assertEqual(json.loads((run_dir / 'run.json').read_text())['configurations'], ['resnet50', {'lr': 0.001}])
    manifest = json.loads((run_dir / 'manifest.outputs.json').read_text())
    self.assertLessEqual({'series.json', 'series.jsonl', 'checkpoints/last.pt', 'model.onnx'}, set(manifest))
    self.assertIn('training done', (run_dir / 'log.txt').read_text())
    self.assertEqual(json.loads((run_dir / 'series.json').read_text())['series']['train/loss']['points'], 100)
    if os.name != 'nt':
      # others, like the server, can list and delete the run's folder
      self.assertEqual(run_dir.stat().st_mode & 0o777, 0o777)
      self.assertEqual((run_dir / 'checkpoints').stat().st_mode & 0o777, 0o777)

  def test_the_web_app_sees_the_metrics_while_the_run_goes_on(self):
    server = self.server()
    result = self.python(server=server, QA_SYNC_INTERVAL='0.1', code="""
import time
import qaboard as qb
from qaboard import Metric
run = qb.start_run(input="train/coco-mini")
run.log({"loss": Metric(1.0, smaller_is_better=True)})
time.sleep(1)
run.log({"loss": 0.5})
run.log_params({"device": "cuda:0"})
time.sleep(1)
run.finish()
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    progress = server.progress()
    self.assertGreaterEqual(len(progress), 2)
    self.assertLessEqual(len(progress), 4)  # only when something changed
    self.assertEqual(progress[0]['metrics'], {'loss': 1.0})
    self.assertEqual(progress[-1], {'metrics': {'loss': 0.5}, 'params': {'device': 'cuda:0'}})
    # how to show the metrics: once, not with every update
    self.assertEqual([p.get('metrics_definitions') for p in progress if 'metrics_definitions' in p], [{'loss': {'smaller_is_better': True}}])
    self.assertEqual(len(server.outputs()), 2)  # started, finished: progress doesn't go through the heavy route
    self.assertNotIn('is_failed', progress[-1]['metrics'])

  def test_older_servers_get_the_metrics_at_the_end(self):
    server = self.server(progress_status=404)
    result = self.python(server=server, QA_SYNC_INTERVAL='0.1', code="""
import time
import qaboard as qb
with qb.start_run(input="train/coco-mini") as run:
  for step in range(3):
    run.log({"loss": 1.0 / (1 + step)})
    time.sleep(0.4)
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertNotIn('WARNING', result.stderr)
    self.assertEqual(len([r for r in server.requests if r[0] == 'PATCH']), 1)  # asked once
    self.assertEqual(server.outputs()[-1]['metrics']['loss'], 1 / 3)

  def test_the_ci_uses_its_commit_and_the_batch_as_named(self):
    server = self.server()
    result = self.python(server=server, CI='true', CI_COMMIT_SHA='a' * 40, CI_COMMIT_REF_NAME='feature/quantize')
    self.assertEqual(result.returncode, 0, result.stderr)
    body = server.outputs()[-1]
    self.assertEqual((body['job_type'], body['commit_sha'], body['commit_branch'], body['batch_label']), ('ci', 'a' * 40, 'feature/quantize', 'lr-sweep'))
    self.assertIn(f"{self.storage}/kitefin/detector/aa/{'a' * 14}/output/lr-sweep/", body['output_directory'])
    self.assertNotIn('dirty', body['data'])

  def test_code_that_differs_from_the_commit_is_marked(self):
    server = self.server()
    (self.project / 'train.py').write_text(TRAINING + "\n# tuned by hand\n")
    result = self.python(server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    data = server.outputs()[0]['data']
    self.assertIs(data['dirty'], True)
    self.assertRegex(data['diff_sha256'], '^[0-9a-f]{16}$')

  def test_sends_the_token(self):
    server = self.server()
    result = self.python(server=server, QABOARD_TOKEN='qab_secret', code="import qaboard as qb\nqb.start_run().finish()")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual({headers.get('Authorization') for _, _, _, headers in server.requests}, {'Bearer qab_secret'})
    # without an input, the run is named after its script: here there is none
    self.assertEqual(server.outputs()[0]['input_path'], 'run')


class TestWhenTheServerIsAway(ActiveRunTestCase):
  """Logging never fails, or waits, because of the server: the files have everything."""
  def test_no_server(self):
    result = self.python(server='http://127.0.0.1:9')
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('WARNING', result.stderr)
    self.assertIn("the server doesn't know how the run ended", result.stderr)
    self.assertIn('training done', result.stdout)
    run_dir = self.shared_dir()
    self.assertEqual(json.loads((run_dir / 'metrics.json').read_text())['mAP'], 0.41)
    self.assertTrue((run_dir / 'series.jsonl').is_file())

  def test_refused_runs_keep_logging_and_ask_once_more_at_the_end(self):
    server = self.server(output_status=403, output_error={'error': 'You need the developer role to send results to kitefin/detector.', 'reason': 'missing_role'})
    result = self.python(server=server, QA_SYNC_INTERVAL='0.1', code="""
import time
import qaboard as qb
with qb.start_run(input="train/coco-mini") as run:
  for step in range(3):
    run.log({"loss": 1.0})
    time.sleep(0.3)
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('the server refused the run: You need the developer role', result.stderr)
    self.assertEqual(len(server.requests), 2)  # when it starts, when it ends: not every few seconds
    self.assertTrue((self.storage / 'kitefin/detector').is_dir())

  def test_a_server_that_comes_back_gets_everything(self):
    # nothing answers when the run starts; then the server is there
    import socket
    with socket.socket() as s:
      s.bind(('127.0.0.1', 0))
      port = s.getsockname()[1]
    (self.project / 'late.py').write_text("""
import sys, time
import qaboard as qb
import qaboard.active_run
qaboard.active_run.MAX_SYNC_INTERVAL = 0.2   # the run asks again later and later while the server is away
with qb.start_run(input="train/coco-mini") as run:
  run.log({"loss": 1.0})
  print("logged", flush=True)
  sys.stdin.readline()   # the test starts the server
  sys.stdin.readline()   # and saw the run's progress
""")
    from qaboard.config import ci_env_variables
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI_', 'GITHUB_')) and k not in ci_env_variables}
    environ.update({'PYTHONPATH': str(ROOT), 'HOME': str(self.home), 'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice', 'QABOARD_URL': f"http://127.0.0.1:{port}", 'QA_SYNC_INTERVAL': '0.1'})
    process = subprocess.Popen([sys.executable, 'late.py'], cwd=self.project, env=environ, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    self.addCleanup(process.kill)
    self.assertEqual(process.stdout.readline().strip(), 'logged')
    server = FakeServer(port=port)
    self.addCleanup(server.close)
    process.stdin.write('go\n')
    process.stdin.flush()
    deadline = time.time() + 30
    while not server.progress() and time.time() < deadline:
      time.sleep(0.05)
    _, stderr = process.communicate('done\n', timeout=60)
    self.assertEqual(process.returncode, 0, stderr)
    started, finished = server.outputs()
    self.assertEqual((started['is_running'], finished['is_pending'], finished['metrics']['loss']), (True, False, 1.0))
    # what was logged while the server was away shows before the run ends
    self.assertEqual(server.progress()[0]['metrics'], {'loss': 1.0})
    self.assertIn('finished: http://127.0.0.1', stderr)

  def test_offline(self):
    server = self.server()
    result = self.python(server=server, QA_OFFLINE='1')
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(server.requests, [])
    # like a local `qa run`: in the project's output/, in the batch as named
    from qaboard.conventions import run_dir_in_commit
    run_dir = self.project / run_dir_in_commit('lr-sweep', 'linux' if os.name != 'nt' else 'windows', ['resnet50', {'lr': 0.001}], {}, 'train/coco-mini', Path('.'), {})
    self.assertEqual(json.loads((run_dir / 'metrics.json').read_text())['val/loss'], 0.5)
    self.assertFalse(any(self.storage.iterdir()))

  def test_share_false(self):
    server = self.server()
    result = self.python(server=server, code="import qaboard as qb\nrun = qb.start_run(share=False)\nassert run.url is None and run.server is None\nrun.finish()")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(server.requests, [])


class TestLifecycle(ActiveRunTestCase):
  def test_an_exception_fails_the_run(self):
    server = self.server()
    result = self.python(server=server, code="""
import qaboard as qb
with qb.start_run(input="train/coco-mini") as run:
  run.log({"loss": 1.0})
  raise RuntimeError("CUDA out of memory")
""")
    self.assertEqual(result.returncode, 1)
    self.assertIn('CUDA out of memory', result.stderr)
    finished = server.outputs()[-1]
    self.assertEqual((finished['is_pending'], finished['is_failed'], finished['metrics']['is_failed']), (False, True, True))
    self.assertEqual(finished['metrics']['loss'], 1.0)
    run_dir = Path(finished['output_directory'])
    log = (run_dir / 'log.txt').read_text()
    self.assertIn('[ERROR] The run failed.', log)
    self.assertIn('RuntimeError: CUDA out of memory', log)
    self.assertIs(json.loads((run_dir / 'metrics.json').read_text())['is_failed'], True)

  def test_runs_nobody_finished_end_with_the_process(self):
    server = self.server()
    result = self.python(server=server, code="import qaboard as qb\nrun = qb.start_run()\nrun.log({'loss': 1.0})")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual([(o['is_pending'], o.get('is_failed')) for o in server.outputs()], [(True, None), (False, False)])
    server.requests.clear()
    result = self.python(server=server, code="import qaboard as qb\nrun = qb.start_run()\nrun.log({'loss': 1.0})\nraise ValueError('bad batch')")
    self.assertEqual(result.returncode, 1)
    self.assertEqual([(o['is_pending'], o.get('is_failed')) for o in server.outputs()], [(True, None), (False, True)])
    self.assertIn('ValueError: bad batch', (Path(server.outputs()[-1]['output_directory']) / 'log.txt').read_text())

  def test_fail_and_finish_once(self):
    server = self.server()
    result = self.python(server=server, code="""
import qaboard as qb
run = qb.start_run()
assert qb.current_run() is run
run.fail("the loss diverged")
run.finish()
assert qb.current_run() is None
assert run.is_failed and run.state == 'finished' and run.error == 'the loss diverged'
# callbacks that fire while a framework shuts down don't end the program: said once, not logged
assert run.log({"loss": 1.0}) == -1
run.log({"loss": 0.5}); run.log_metrics({"x": 1}); run.log_params({"y": 2})
assert run.log_artifact("late.txt", b"x") is None
assert dict(run.metrics) == {}, run.metrics
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(result.stderr.count('the run is finished, not logged'), 1)
    self.assertEqual(len(server.outputs()), 2)
    self.assertIn('the loss diverged', (Path(server.outputs()[-1]['output_directory']) / 'log.txt').read_text())

  def test_doing_a_run_again_is_a_new_attempt_and_resume_continues_it(self):
    server = self.server()
    code = """
import sys
import qaboard as qb
with qb.start_run(input="train/coco-mini", resume=sys.argv[1] == 'resume') as run:
  print("attempt output", sys.argv[1])
  print(run.log({"loss": 1.0}), file=sys.stderr)
  (run.output_dir / f"checkpoint-{sys.argv[1]}.pt").write_bytes(b"weights")
"""
    (self.project / 'again.py').write_text(code)
    directories = []
    for mode in ('first', 'second', 'resume'):
      result = subprocess.run([sys.executable, 'again.py', mode], cwd=self.project, capture_output=True, text=True, timeout=120, env={
        **{k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI', 'GITHUB_', 'GIT_'))},
        'PYTHONPATH': str(ROOT), 'HOME': str(self.home), 'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice', 'QABOARD_URL': server.url,
      })
      self.assertEqual(result.returncode, 0, result.stderr)
      directories.append(Path(server.outputs()[-1]['output_directory']))
    first, second, resumed = directories
    # like `qa run` (qaboard/attempts.py): its own directory, the previous attempt's files removed, its log kept
    self.assertEqual(second.name, f"{first.name}_attempt2")
    self.assertEqual((first / 'latest_attempt.txt').read_text().strip(), '2')
    self.assertFalse((first / 'checkpoint-first.pt').exists())
    self.assertIn('attempt output first', (second / 'log.attempt1.txt').read_text())
    self.assertEqual(server.outputs()[3]['data']['attempt_logs'], [1])
    # resume: the same directory, with its files, and the steps go on
    self.assertEqual(resumed, second)
    self.assertTrue((second / 'checkpoint-second.pt').exists() and (second / 'checkpoint-resume.pt').exists())
    self.assertEqual([json.loads(line)['_step'] for line in (second / 'series.jsonl').read_text().splitlines()], [0, 1])

  def test_what_logging_accepts(self):
    result = self.python(QA_OFFLINE='1', code="""
import math
import qaboard as qb
from qaboard import Run

def raises(error, call, *args, **kwargs):
  try:
    call(*args, **kwargs)
  except error as e:
    return str(e)
  raise AssertionError(f"{call.__name__}{args} did not raise {error.__name__}")

run = qb.start_run(input="eval", configs={"lr": 0.1}, output_dir="my-run", capture_output=False)
assert run.configs == ({"lr": 0.1},) and run.params == {"lr": 0.1}
assert run.output_dir.name == "my-run" and run.output_dir.is_absolute()
assert run.log({"loss": 1.0}) == 0 and run.log({"loss": 0.5}) == 1 and run.log({"loss": 0.25}, step=10) == 10
assert run.log({"loss": math.nan}) == 11          # kept in the series, not in the metric
assert dict(run.metrics) == {"loss": 0.25}, run.metrics
assert [p.step for p in run.series("loss")] == [0, 1, 10, 11]
# the call's shape is checked: mistakes show the first time
assert 'mapping' in raises(TypeError, run.log, 1.0)
assert 'integer' in raises(TypeError, run.log, {"loss": 1}, step="first")
assert 'integer' in raises(TypeError, run.log, {"loss": 1}, step=1.7)
raises(ValueError, run.log, {"_step": 1})
raises(ValueError, run.log, {"x" * 201: 1})
# like log_metrics: the run sets them, and the server would refuse everything sent with them
for name in ("is_failed", "compute_time"):
  assert "the run's own" in raises(ValueError, run.log, {name: 1})
# values are not: hours into a training, a text or a missing value is skipped, the rest is logged
assert run.log({"loss": "high", "lr": None, "ok": 2.0}, step=12.0) == 12
assert [p.step for p in run.series("ok")] == [12] and run.series("lr") == [] and len(run.series("loss")) == 4
assert 'run.fail()' in raises(ValueError, run.log_metrics, {"is_failed": True})
raises(TypeError, run.log_metrics, {"x": [1, 2]})
raises(ValueError, run.log_artifact, "../outside.txt", b"x")
raises(ValueError, run.log_artifact, "report.txt", "not-a-file")
run.log_metrics({"mAP": 0.41, "verdict": "good", "nan": math.nan, "loss": 0.2})
run.log_params({"model": {"depth": 50}})
run.log_params({"model": {"width": 2}, "lr": 0.2})
run.log_metrics({"long": "x" * 600})
assert dict(run.metrics) == {"loss": 0.2, "ok": 2.0, "mAP": 0.41, "verdict": "good", "long": "x" * 500}, run.metrics
assert run.params == {"lr": 0.2, "model": {"depth": 50, "width": 2}}, run.params
# saving the same name again replaces the file: it is the run's own
run.log_artifact("checkpoints/last.pt", b"1")
assert run.log_artifact("checkpoints/last.pt", b"22").read_bytes() == b"22"
# a file alone keeps its name
(run.output_dir.parent / "report.html").write_text("<p>ok</p>")
assert run.log_artifact(run.output_dir.parent / "report.html") == run.output_dir / "report.html"
# the same Run as qaboard.runs(url) gives
picture = run.run
assert type(picture) is Run and picture.state == 'running' and picture.input == 'eval' and picture.metrics == run.metrics
assert picture.params == run.params and picture.data['params'] == {"model": {"depth": 50, "width": 2}, "lr": 0.2}
run.finish()
assert run.run.state == 'finished' and run.run.metrics['is_failed'] is False
assert [p.value for p in run.run.series("loss")][:3] == [1.0, 0.5, 0.25]
assert not (run.output_dir / 'log.txt').exists()
raises(TypeError, qb.start_run, configs=[1])
raises(ValueError, qb.start_run, input="../other")
raises(ValueError, qb.start_run, summary="median")
raises(ValueError, qb.start_run, project="another/project")
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(result.stderr.count('not logging loss'), 1)

  def test_summaries_by_pattern(self):
    result = self.python(QA_OFFLINE='1', code="""
import qaboard as qb
run = qb.start_run(summary={"val/*": "min", "system/*": "none", "val/top1": "max"})
for value in (3.0, 1.0, 2.0):
  run.log({"val/loss": value, "val/top1": value, "system/gpu": value, "train/loss": value})
assert dict(run.metrics) == {"val/loss": 1.0, "val/top1": 3.0, "train/loss": 2.0}, run.metrics
run.finish()
""")
    self.assertEqual(result.returncode, 0, result.stderr)

  def test_starting_a_run_again_while_it_goes_on_ends_the_first(self):
    # a notebook's cell run twice
    server = self.server()
    result = self.python(server=server, code="""
import sys
import qaboard as qb
first = qb.start_run(input="notebook")
first.log({"loss": 1.0})
print("from the first")
second = qb.start_run(input="notebook")
assert first.state == 'finished' and qb.current_run() is second
second.log({"loss": 0.1})
print("from the second")
other = qb.start_run(input="another")   # another run: both go on
assert second.state == 'running'
other.finish()
second.finish()
assert sys.stdout is sys.__stdout__ and sys.stderr is sys.__stderr__
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('was not finished: finishing it', result.stderr)
    last = [o for o in server.outputs() if o['input_path'] == 'notebook'][-1]
    # the server ends on the second run: its folder, its metrics
    self.assertTrue(last['output_directory'].endswith('_attempt2'), last['output_directory'])
    self.assertEqual((last['is_pending'], last['metrics']['loss']), (False, 0.1))
    log = (Path(last['output_directory']) / 'log.txt').read_text()
    self.assertIn('from the second', log)
    self.assertNotIn('from the first', log)

  def test_overlapping_runs_give_the_streams_back(self):
    result = self.python(QA_OFFLINE='1', code="""
import sys
import qaboard as qb
a = qb.start_run(input="a")
b = qb.start_run(input="b")
a.finish()
print("only for b")
b.finish()
assert sys.stdout is sys.__stdout__ and sys.stderr is sys.__stderr__, sys.stdout
assert "only for b" in (b.output_dir / "log.txt").read_text()
assert "only for b" not in (a.output_dir / "log.txt").read_text()
""")
    self.assertEqual(result.returncode, 0, result.stderr)

  def test_resume_keeps_what_was_logged_even_after_a_kill(self):
    code = """
import os, signal, sys, time
import qaboard as qb
import qaboard.active_run
qaboard.active_run.FLUSH_INTERVAL = 0.1
run = qb.start_run(input="train/coco-mini", resume=True)
if sys.argv[1] == 'first':
  run.log({"loss": 1.0})
  run.log_metrics({"best_epoch": 3})
  run.log_params({"device": "cuda:0"})
  time.sleep(1)
  os.kill(os.getpid(), signal.SIGKILL)   # nothing is saved on the way out
assert run.log({"loss": 0.5}) == 1
assert dict(run.metrics) == {"loss": 0.5, "best_epoch": 3}, run.metrics
assert run.params == {"device": "cuda:0"}, run.params
before = run._previous_time
assert before > 0, before   # how long it ran before counts
run.finish()
assert run.run.metrics["compute_time"] >= before
"""
    (self.project / 'resume.py').write_text(code)
    first = self.python(code="import sys; sys.argv = ['resume.py', 'first']; exec(open('resume.py').read())", QA_OFFLINE='1')
    self.assertNotEqual(first.returncode, 0)
    second = self.python(code="import sys; sys.argv = ['resume.py', 'second']; exec(open('resume.py').read())", QA_OFFLINE='1')
    self.assertEqual(second.returncode, 0, second.stderr)

  def test_a_killed_job_fails_its_run(self):
    # schedulers end jobs with SIGTERM: without a `with` block too, the run doesn't stay "running"
    server = self.server()
    (self.project / 'killed.py').write_text("""
import sys, time
import qaboard as qb
run = qb.start_run(input="train/coco-mini")
run.log({"loss": 1.0})
print("started", flush=True)
time.sleep(60)
""")
    from qaboard.config import ci_env_variables
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI_', 'GITHUB_')) and k not in ci_env_variables}
    environ.update({'PYTHONPATH': str(ROOT), 'HOME': str(self.home), 'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice', 'QABOARD_URL': server.url})
    process = subprocess.Popen([sys.executable, 'killed.py'], cwd=self.project, env=environ, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    self.addCleanup(process.kill)
    self.assertEqual(process.stdout.readline().strip(), 'started')
    process.terminate()
    process.communicate(timeout=60)
    self.assertNotEqual(process.returncode, 0)
    self.assertEqual([(o['is_pending'], o.get('is_failed')) for o in server.outputs()], [(True, None), (False, True)])

  @unittest.skipUnless(hasattr(os, 'fork'), 'needs fork')
  def test_forked_workers_dont_log(self):
    result = self.python(QA_OFFLINE='1', code="""
import os
import qaboard as qb
run = qb.start_run(input="train/coco-mini", capture_output=False)
run.log({"loss": 1.0})
pid = os.fork()
if pid == 0:
  assert run.log({"loss": 0.0}) == -1
  os._exit(0)
assert os.waitpid(pid, 0)[1] == 0
assert [p.value for p in run.series("loss")] == [1.0]
run.finish()
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('in another process than the run', result.stderr)

  def test_long_lived_processes_use_the_commit_of_now(self):
    # a notebook that commits between two runs
    server = self.server()
    result = self.python(server=server, code="""
import subprocess
import qaboard as qb
qb.start_run(input="a").finish()
open("notes.txt", "w").write("more")
subprocess.run(["git", "add", "notes.txt"], check=True)
subprocess.run(["git", "-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "Notes"], check=True)
run = qb.start_run(input="b")
print(run.commit)
run.finish()
""")
    self.assertEqual(result.returncode, 0, result.stderr)
    head = git(self.project, 'rev-parse', 'HEAD')
    self.assertNotEqual(head, self.commit)
    last = server.outputs()[-1]
    self.assertEqual((last['commit_sha'], last['commit_message'].strip()), (head, 'Notes'))
    self.assertNotIn('dirty', last['data'])
    self.assertIn(f"/{head[:2]}/{head[2:16]}/", last['output_directory'])


class TestWithoutAProject(ActiveRunTestCase):
  """Notebooks and scripts outside a project: no qaboard.yaml, maybe no git."""
  def setUp(self):
    super().setUp()
    self.notebooks = Path(self.tmp.name).resolve() / 'notebooks'
    self.notebooks.mkdir()

  def test_needs_the_project(self):
    result = self.python(cwd=self.notebooks, code="import qaboard as qb\nqb.start_run()")
    self.assertEqual(result.returncode, 1)
    self.assertIn("pass project='group/repo'", result.stderr)

  def test_without_storage_runs_stay_local(self):
    server = self.server()
    code = "import qaboard as qb\nwith qb.start_run(project='kitefin/detector', input='explore') as run:\n  run.log({'loss': 1.0})\nprint(run.output_dir)"
    result = self.python(cwd=self.notebooks, server=server, code=code)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(server.requests, [])
    self.assertTrue(Path(result.stdout.strip()).is_relative_to(self.notebooks / 'output'))
    result = self.python(cwd=self.notebooks, server=server, code="import qaboard as qb\nqb.start_run(project='kitefin/detector', share=True)")
    self.assertIn('needs the shared storage', result.stderr)

  def test_with_storage_runs_are_shared_under_a_placeholder_commit(self):
    server = self.server()
    code = "import qaboard as qb\nwith qb.start_run(project='kitefin/detector', input='explore') as run:\n  run.log({'loss': 1.0})"
    result = self.python(cwd=self.notebooks, server=server, code=code, QA_STORAGE=str(self.storage))
    self.assertEqual(result.returncode, 0, result.stderr)
    body = server.outputs()[-1]
    self.assertEqual((body['project'], body['commit_sha'], body['batch_label']), ('kitefin/detector', '<local:alice>', '@alice| default'))
    self.assertTrue(body['commit_authored_datetime'])
    # the project keeps the configuration its qaboard.yaml gave it: we don't send an empty one
    self.assertNotIn('qaboard_config', body)
    self.assertTrue(body['output_directory'].startswith(f"{self.storage}/kitefin/detector/local/alice/output/"), body['output_directory'])

  def test_attached_to_a_commit(self):
    server = self.server()
    code = f"import qaboard as qb\nqb.start_run(project='kitefin/detector', commit='{'b' * 40}').finish()"
    result = self.python(cwd=self.notebooks, server=server, code=code, QA_STORAGE=str(self.storage))
    self.assertEqual(result.returncode, 0, result.stderr)
    body = server.outputs()[-1]
    self.assertEqual(body['commit_sha'], 'b' * 40)
    self.assertIn(f"/kitefin/detector/bb/{'b' * 14}/output/", body['output_directory'])
    result = self.python(cwd=self.notebooks, code="import qaboard as qb\nqb.start_run(project='kitefin/detector', commit='main')")
    self.assertIn("give the commit's full id", result.stderr)


class TestImport(ActiveRunTestCase):
  def test_import_qaboard_stays_light(self):
    result = self.python(code="import sys, qaboard\nassert 'qaboard.active_run' not in sys.modules and 'qaboard.config' not in sys.modules\nassert callable(qaboard.start_run) and qaboard.current_run() is None")
    self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
  unittest.main()
