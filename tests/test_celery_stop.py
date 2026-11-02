"""
Stopping Celery batches: a real worker, with kombu's filesystem transport (no broker to run).
`qa batch` and the QA-Board server stop a batch from its command id only (CeleryRunner.stop_jobs):
waiting tasks are dropped, running ones are killed with everything their command started.
"""
import os
import sys
import time
import shutil
import signal
import tempfile
import unittest
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

try:
  import celery  # noqa: F401
  has_celery = True
except ImportError:
  has_celery = False


WORKER_MODULE = """
from qaboard.runners.celery_app import app
app.conf.update(
  broker_url='filesystem://',
  broker_transport_options={transport_options!r},
  result_backend='cache+memory://',
  worker_prefetch_multiplier=1,
)
"""


def alive(pid: int) -> bool:
  try:
    os.kill(pid, 0)
  except ProcessLookupError:
    return False
  # zombies are dead
  try:
    with open(f'/proc/{pid}/stat') as f:
      return f.read().split(')')[-1].split()[0] != 'Z'
  except OSError:
    return True


def wait_for(condition, timeout=60, interval=0.2):
  deadline = time.time() + timeout
  while time.time() < deadline:
    if condition():
      return True
    time.sleep(interval)
  return False


@unittest.skipUnless(has_celery, "needs celery")
class TestCeleryStopJobs(unittest.TestCase):
  def test_server_options(self):
    """The server gives only the type and command id: the broker comes from its CELERY_BROKER_URL"""
    from qaboard.runners.celery import CeleryRunner
    sent = []
    class Control:
      def revoke_by_stamped_headers(self, headers, **kwargs):
        sent.append(('stamps', headers, kwargs['terminate']))
      def revoke(self, ids, **kwargs):
        sent.append(('ids', ids, kwargs['terminate']))
    class Connection:
      def __enter__(self):
        return self
      def __exit__(self, *args):
        pass
      def ensure_connection(self, **kwargs):
        pass
    apps = []
    class App:
      def __init__(self, *args, **kwargs):
        self.conf = {}
        self.control = Control()
        apps.append(self)
      def connection_for_write(self):
        return Connection()
    with mock.patch.dict(os.environ, {'CELERY_BROKER_URL': 'pyamqp://qaboard:secret@rabbitmq//'}), mock.patch('celery.Celery', App):
      CeleryRunner.stop_jobs([], {"type": "celery", "command_id": "abcd-1234", "bridge": "", "user": "alice"})
    self.assertEqual(apps[0].conf['broker_url'], 'pyamqp://qaboard:secret@rabbitmq//')
    # the server's options are not Celery settings
    self.assertFalse({'type', 'command_id', 'bridge', 'user'} & set(apps[0].conf))
    self.assertEqual(sent, [('stamps', {'qaboard_command_id': 'abcd-1234'}, True)])

    # from `qa batch`, we also know the tasks' ids
    sent.clear()
    with mock.patch('celery.Celery', App):
      CeleryRunner.stop_jobs([None, None], {"type": "celery", "command_id": "abcd-1234", "broker_url": "pyamqp://x//"})
    self.assertEqual(apps[-1].conf['broker_url'], 'pyamqp://x//')
    self.assertEqual(sent, [('stamps', {'qaboard_command_id': 'abcd-1234'}, True), ('ids', ['abcd-1234-0', 'abcd-1234-1'], True)])


@unittest.skipUnless(has_celery, "needs celery")
@unittest.skipIf(os.name == 'nt', "process groups")
class TestCeleryStopWithAWorker(unittest.TestCase):
  def setUp(self):
    self.tmp = Path(tempfile.mkdtemp(prefix='qaboard-celery-'))
    self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
    broker = self.tmp / 'broker'
    (broker / 'control').mkdir(parents=True)
    self.transport_options = {
      'data_folder_in': str(broker),
      'data_folder_out': str(broker),
      'control_folder': str(broker / 'control'),
      'polling_interval': 0.2,
    }
    worker_dir = self.tmp / 'worker'
    worker_dir.mkdir()
    (worker_dir / 'qaboard_test_worker.py').write_text(WORKER_MODULE.format(transport_options=self.transport_options))
    self.worker_log = self.tmp / 'worker.log'
    repo = Path(__file__).resolve().parent.parent
    # C_FORCE_ROOT: in containers, tests may run as root
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(worker_dir), str(repo)]), 'C_FORCE_ROOT': '1', 'QABOARD_HOST': 'localhost:5151'}
    env.pop('CELERY_BROKER_URL', None)
    with self.worker_log.open('w') as log:
      self.worker = subprocess.Popen(
        [sys.executable, '-m', 'celery', '-A', 'qaboard_test_worker', 'worker', '--pool=prefork', '--concurrency=1',
         '--without-heartbeat', '--without-gossip', '--without-mingle', '--loglevel=info'],
        cwd=worker_dir, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
      )
    def stop_worker():
      try:
        os.killpg(self.worker.pid, signal.SIGKILL)
      except OSError:
        pass
      self.worker.wait()
    self.addCleanup(stop_worker)

  def job(self, index):
    # each run starts a process in the background, like runs that start tools
    work = self.tmp / 'work'
    work.mkdir(exist_ok=True)
    command = f'echo $$ > {work}/shell-{index}; sleep 600 & echo $! > {work}/child-{index}; wait'
    return SimpleNamespace(run_context=SimpleNamespace(command=command, job_options={'cwd': str(work)}))

  def pid(self, name):
    path = self.tmp / 'work' / name
    return int(path.read_text()) if path.exists() and path.read_text().strip() else None

  def test_stop_a_batch(self):
    from qaboard.runners.celery import CeleryRunner
    command_id = 'c0ffee00-1234'
    job_options = {
      'type': 'celery', 'command_id': command_id, 'cwd': str(self.tmp),
      'broker_url': 'filesystem://', 'broker_transport_options': self.transport_options,
      'result_backend': 'cache+memory://',
    }
    jobs = [self.job(0), self.job(1)]
    cwd = os.getcwd()
    try:
      CeleryRunner.start_jobs(jobs, job_options, blocking=False)
    finally:
      os.chdir(cwd)
    started = wait_for(lambda: (self.pid('shell-0') and self.pid('child-0')) or self.worker.poll() is not None)
    started = started and self.worker.poll() is None
    self.assertTrue(started, f"The worker didn't start the first run:\n{self.worker_log.read_text()}")
    shell, child = self.pid('shell-0'), self.pid('child-0')
    self.assertTrue(alive(shell) and alive(child))

    # like the server: only the type and the command id
    with mock.patch.dict(os.environ, {'CELERY_BROKER_URL': 'filesystem://'}):
      CeleryRunner.stop_jobs([], {'type': 'celery', 'command_id': command_id, 'bridge': '',
                                  'broker_transport_options': self.transport_options})
    stopped = wait_for(lambda: not alive(shell) and not alive(child), timeout=30)
    self.assertTrue(stopped, f"The run and what it started still run:\n{self.worker_log.read_text()}")
    # the second task waited: it never runs
    time.sleep(3)
    self.assertIsNone(self.pid('shell-1'), self.worker_log.read_text())
    # the worker goes on
    self.assertIsNone(self.worker.poll())
