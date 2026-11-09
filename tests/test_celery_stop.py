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
  result_backend={result_backend!r},
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

    # from the `qa batch` that sent them (Ctrl+C), we also know the tasks' ids
    sent.clear()
    with mock.patch('celery.Celery', App), mock.patch.dict('qaboard.runners.celery.sent_task_ids', {'abcd-1234': ['abcd-1234-n1-0', 'abcd-1234-n1-1']}):
      CeleryRunner.stop_jobs([None, None], {"type": "celery", "command_id": "abcd-1234", "broker_url": "pyamqp://x//"})
    self.assertEqual(apps[-1].conf['broker_url'], 'pyamqp://x//')
    self.assertEqual(sent, [('stamps', {'qaboard_command_id': 'abcd-1234'}, True), ('ids', ['abcd-1234-n1-0', 'abcd-1234-n1-1'], True)])

  def test_task_ids_are_new_for_each_batch(self):
    """`qa optimize` iterations reuse the command id: their tasks must not have the ids of the previous iteration's"""
    from qaboard.runners import celery as celery_runner
    from qaboard.runners.celery import CeleryRunner
    calls = []
    class Group:
      def __init__(self, signatures):
        self.signatures = list(signatures)
      def stamp(self, **headers):
        self.headers = headers
      def __call__(self):
        calls.append(self)
        return None
    jobs = [SimpleNamespace(run_context=SimpleNamespace(command='true', job_options={})) for _ in range(2)]
    with mock.patch('celery.group', Group), mock.patch.dict(celery_runner.sent_task_ids, clear=True):
      for _ in range(2):
        CeleryRunner.start_jobs(jobs, {"type": "celery", "command_id": "abcd-1234"}, blocking=False)
      first, second = [[s.options['task_id'] for s in g.signatures] for g in calls]
      self.assertEqual(len(set(first + second)), 4)
      self.assertTrue(all(id.startswith('abcd-1234-') for id in first + second))
      # stopping still works from the command id, and Ctrl+C revokes the ids it sent
      self.assertEqual([g.headers for g in calls], [{'qaboard_command_id': 'abcd-1234'}] * 2)
      self.assertEqual(celery_runner.sent_task_ids['abcd-1234'], first + second)


class TestCeleryEnvironment(unittest.TestCase):
  ENV = {
    'PATH': '/bin', 'OK': '1', 'KEYBOARD': 'fr',
    'GITLAB_TOKEN': 'x', 'AWS_ACCESS_KEY_ID': 'x', 'DB_PASS': 'x', 'MY_PW': 'x', 'SESSION_ID': 'x', 'WANDB_API_KEY': 'x',
    'CI_REPOSITORY_URL': 'https://gitlab-ci-token:xxx@gitlab.example.com/a/b.git', 'PROXY': 'http://proxy:3128',
  }

  def test_runs_dont_get_secrets(self):
    from qaboard.runners.celery import without_secrets
    with mock.patch.dict(os.environ, self.ENV, clear=True):
      self.assertEqual(without_secrets(), {'PATH': '/bin', 'OK': '1', 'KEYBOARD': 'fr', 'PROXY': 'http://proxy:3128'})
      # runners.celery.forward_secrets: unless they're named
      env = without_secrets(['WANDB_API_KEY', 'CI_REPOSITORY_URL', 'NOT_SET'])
    self.assertEqual(env['WANDB_API_KEY'], 'x')
    self.assertIn('CI_REPOSITORY_URL', env)
    self.assertNotIn('NOT_SET', env)
    self.assertNotIn('GITLAB_TOKEN', env)

  def test_forward_secrets_setting(self):
    from qaboard.runners.celery import forward_secrets_option
    from qaboard.runners.celery_settings import celery_settings
    config = {'runners': {'celery': {'forward_secrets': ['WANDB_API_KEY'], 'broker_url': 'pyamqp://x//'}}}
    with mock.patch('qaboard.config.config', config):
      self.assertEqual(forward_secrets_option({}), ['WANDB_API_KEY'])
      # from an input type's runners.celery
      self.assertEqual(forward_secrets_option({'forward_secrets': 'HF_TOKEN'}), ['HF_TOKEN'])
      self.assertEqual(forward_secrets_option({'forward_secrets': [1]}), [])
    with mock.patch('qaboard.config.config', {}):
      self.assertEqual(forward_secrets_option({}), [])
    # it's not a Celery setting
    self.assertEqual(celery_settings(config), {'broker_url': 'pyamqp://x//'})


@unittest.skipUnless(has_celery, "needs celery")
@unittest.skipIf(os.name == 'nt', "process groups")
class TestCeleryStopWithAWorker(unittest.TestCase):
  pool = 'prefork'
  # the default, rpc://, needs a real broker
  result_backend = 'cache+memory://'

  @staticmethod
  def reset_celery_app():
    """Each test has its own broker and result backend: `qa`'s Celery app must not keep the previous one's"""
    from kombu import pools
    from qaboard.runners.celery_app import app
    pools.reset()
    app._pool = None
    app.amqp._producer_pool = None
    app._backend_cache = None
    vars(app._local).pop('backend', None)

  def setUp(self):
    self.reset_celery_app()
    self.addCleanup(self.reset_celery_app)
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
    if self.result_backend.startswith('file://'):
      (self.tmp / 'results').mkdir()
      self.result_backend = f"file://{self.tmp / 'results'}"
    worker_dir = self.tmp / 'worker'
    worker_dir.mkdir()
    (worker_dir / 'qaboard_test_worker.py').write_text(WORKER_MODULE.format(transport_options=self.transport_options, result_backend=self.result_backend))
    self.worker_log = self.tmp / 'worker.log'
    repo = Path(__file__).resolve().parent.parent
    # C_FORCE_ROOT: in containers, tests may run as root
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join([str(worker_dir), str(repo)]), 'C_FORCE_ROOT': '1', 'QABOARD_HOST': 'localhost:5151'}
    env.pop('CELERY_BROKER_URL', None)
    with self.worker_log.open('w') as log:
      self.worker = subprocess.Popen(
        [sys.executable, '-m', 'celery', '-A', 'qaboard_test_worker', 'worker', f'--pool={self.pool}', '--concurrency=1',
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

  def job_options(self, command_id):
    return {
      'type': 'celery', 'command_id': command_id, 'cwd': str(self.tmp),
      'broker_url': 'filesystem://', 'broker_transport_options': self.transport_options,
      'result_backend': self.result_backend,
    }

  def started(self, name):
    started = wait_for(lambda: self.pid(name) or self.worker.poll() is not None)
    return started and self.worker.poll() is None

  def test_stop_a_batch(self):
    from qaboard.runners.celery import CeleryRunner
    command_id = 'c0ffee00-1234'
    job_options = self.job_options(command_id)
    jobs = [self.job(0), self.job(1)]
    cwd = os.getcwd()
    try:
      CeleryRunner.start_jobs(jobs, job_options, blocking=False)
    finally:
      os.chdir(cwd)
    # the filesystem broker doesn't keep the order of the tasks: either may run first
    def running():
      return next((index for index in (0, 1) if self.pid(f'shell-{index}') and self.pid(f'child-{index}')), None)
    started = wait_for(lambda: running() is not None or self.worker.poll() is not None)
    started = started and self.worker.poll() is None
    self.assertTrue(started, f"The worker didn't start a run:\n{self.worker_log.read_text()}")
    first = running()
    shell, child = self.pid(f'shell-{first}'), self.pid(f'child-{first}')
    self.assertTrue(alive(shell) and alive(child))

    # like the server: only the type and the command id
    with mock.patch.dict(os.environ, {'CELERY_BROKER_URL': 'filesystem://'}):
      CeleryRunner.stop_jobs([], {'type': 'celery', 'command_id': command_id, 'bridge': '',
                                  'broker_transport_options': self.transport_options})
    stopped = wait_for(lambda: not alive(shell) and not alive(child), timeout=30)
    self.assertTrue(stopped, f"The run and what it started still run:\n{self.worker_log.read_text()}")
    # the second task waited: it never runs
    time.sleep(3)
    self.assertIsNone(self.pid(f'shell-{1 - first}'), self.worker_log.read_text())
    # the worker goes on
    self.assertIsNone(self.worker.poll())


@unittest.skipUnless(has_celery, "needs celery")
@unittest.skipIf(os.name == 'nt', "process groups")
class TestCeleryWithAResultBackend(TestCeleryStopWithAWorker):
  """A result backend that keeps results, like Redis or a database"""
  result_backend = 'file://'

  def test_stop_a_batch(self):
    pass

  def test_reused_command_ids_wait_for_their_own_tasks(self):
    """`qa optimize` iterations started from the web app have the same command id: each waits for its own runs"""
    from qaboard.runners.celery import CeleryRunner
    work = self.tmp / 'work'
    work.mkdir()
    def job(command):
      return SimpleNamespace(run_context=SimpleNamespace(command=command, job_options={'cwd': str(work)}))
    def timeout(signum, frame):
      raise TimeoutError(self.worker_log.read_text())
    previous = signal.signal(signal.SIGALRM, timeout)
    handlers = signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)
    cwd = os.getcwd()
    try:
      signal.alarm(120)
      CeleryRunner.start_jobs([job(f'echo 1 > {work}/first')], self.job_options('c0ffee00-5678'), blocking=True)
      self.assertTrue((work / 'first').exists())
      CeleryRunner.start_jobs([job(f'sleep 2; echo 2 > {work}/second')], self.job_options('c0ffee00-5678'), blocking=True)
      # not the result of the first iteration's task
      self.assertTrue((work / 'second').exists(), self.worker_log.read_text())
      # Ctrl+C has nothing left to revoke
      from qaboard.runners.celery import sent_task_ids
      self.assertEqual(sent_task_ids['c0ffee00-5678'], [])
    finally:
      signal.alarm(0)
      signal.signal(signal.SIGALRM, previous)
      os.chdir(cwd)
    # start_jobs leaves the signal handlers as they were
    self.assertEqual((signal.getsignal(signal.SIGINT), signal.getsignal(signal.SIGTERM)), handlers)


@unittest.skipUnless(has_celery, "needs celery")
@unittest.skipIf(os.name == 'nt', "process groups")
class TestCelerySoloPool(TestCeleryStopWithAWorker):
  """With --pool=solo, tasks run in the worker's process: SIGTERM is the worker's warm shutdown"""
  pool = 'solo'

  def test_stop_a_batch(self):
    pass

  def test_warm_shutdown_lets_the_run_finish(self):
    from qaboard.runners.celery import CeleryRunner
    work = self.tmp / 'work'
    work.mkdir()
    command = f'echo $$ > {work}/shell-0; sleep 3; echo done > {work}/done'
    job = SimpleNamespace(run_context=SimpleNamespace(command=command, job_options={'cwd': str(work)}))
    cwd = os.getcwd()
    try:
      CeleryRunner.start_jobs([job], self.job_options('c0ffee00-9abc'), blocking=False)
    finally:
      os.chdir(cwd)
    self.assertTrue(self.started('shell-0'), f"The worker didn't start the run:\n{self.worker_log.read_text()}")
    self.worker.send_signal(signal.SIGTERM)
    try:
      self.worker.wait(timeout=60)
    except subprocess.TimeoutExpired:
      self.fail(f"The worker didn't stop:\n{self.worker_log.read_text()}")
    log = self.worker_log.read_text()
    self.assertTrue((work / 'done').exists(), f"The run was killed:\n{log}")
    self.assertEqual(self.worker.returncode, 0, log)
