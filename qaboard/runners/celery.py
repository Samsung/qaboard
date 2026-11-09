import os
import re
import sys
import uuid
import socket
import fnmatch
from typing import List, Dict, Any, Iterable, Optional, Tuple

from .base import BaseRunner
from .job import Job
from ..checks import Check
# is_secret: imported from here by other modules. The filter is shared by the runners (env.py)
from .env import is_secret


def without_secrets(forward_secrets: Optional[Iterable[str]] = None) -> Dict[str, str]:
  """
  qa's environment, minus the variables that likely hold secrets (env.py's is_secret, from their name or value):
  the runs get it. `forward_secrets` (runners.celery.forward_secrets) names variables to forward anyway.
  """
  env = {k: v for k, v in os.environ.items() if not is_secret(k, v)}
  for name in forward_secrets or ():
    if name in os.environ:
      env[name] = os.environ[name]
  return env


def forward_secrets_option(job_options: Dict[str, Any]) -> List[str]:
  """runners.celery.forward_secrets: the names of variables to forward even if they look like secrets"""
  value = job_options.get('forward_secrets')
  if value is None:
    from ..config import config
    from .celery_settings import qaboard_settings
    value = qaboard_settings(config).get('forward_secrets')
  if value is None:
    return []
  if isinstance(value, str):
    value = [value]
  if not isinstance(value, (list, tuple)) or not all(isinstance(name, str) for name in value):
    print(f"WARNING: runners.celery.forward_secrets should be a list of variable names, not {value!r}: no secrets are forwarded.", file=sys.stderr)
    return []
  return list(value)


# What `qa batch`, `qa doctor` and the QA-Board server add to the job options, and the runner's own settings
# (celery_settings.QABOARD_SETTINGS): they are not Celery settings
QA_JOB_OPTIONS = ('type', 'command_id', 'user', 'project', 'batch_dir', 'cwd', 'bridge', 'forward_secrets')

# Each task of a batch is stamped with its command id (a header), so that we can stop them all from it, from
# anywhere that reaches the broker, without a result backend: see stop_jobs.
COMMAND_ID_STAMP = 'qaboard_command_id'

def task_id(command_id: str, nonce: str, index: int) -> str:
  """
  The tasks of a batch have known ids: workers older than Celery 5.3 can't revoke them by stamp. Each `qa batch`
  (or each `qa optimize` iteration, that reuses the command id) has its own nonce: with a result backend that keeps
  results, waiting for a task must not find the result of a task from before with the same id.
  """
  return f"{command_id}-{nonce}-{index}"

# The tasks this process sent, per command id: Ctrl+C and stop_jobs from `qa batch` revoke them by id
sent_task_ids: Dict[str, List[str]] = {}

def doctor_settings(job_options: Dict[str, Any]) -> Tuple[Dict[str, Any], str, str]:
  """
  The runner's Celery settings (qaboard.yaml's runners.celery, with environment variables expanded),
  the broker URL, and what gives it: runners.celery.broker_url > $CELERY_BROKER_URL > the default (see celery_app.py).
  """
  from .celery_settings import celery_settings
  settings = celery_settings({'runners': {'celery': {k: v for k, v in job_options.items() if k not in QA_JOB_OPTIONS}}})
  if settings.get('broker_url'):
    return settings, settings['broker_url'], "runners.celery.broker_url in qaboard.yaml"
  if os.environ.get('CELERY_BROKER_URL'):
    return settings, os.environ['CELERY_BROKER_URL'], "$CELERY_BROKER_URL"
  from .celeryconfig import broker_url
  return settings, broker_url, "the default: neither runners.celery.broker_url nor CELERY_BROKER_URL is set"


def check_broker(broker_url: str, source: str, page: str, timeout: float = 3) -> Check:
  """The broker answers, and accepts the account in its URL."""
  from ..checks import OK, ERROR
  from ..doctor import mask_url_password
  name = "Celery broker"
  masked = mask_url_password(broker_url)
  unset = re.findall(r'\$\{?([A-Za-z_][A-Za-z0-9_]*)', broker_url)
  if unset:
    return Check(name, ERROR, f"The broker URL uses ${unset[0]}, which isn't set: {masked} (from {source})",
                 fix=f"export {unset[0]}=...   # ask whoever gave you the broker's account\nDocs: {page}#sharing-the-servers-broker-between-teams")
  if source.startswith('the default'):
    fix = ("Set your broker in qaboard.yaml:\nrunners:\n  celery:\n    broker_url: pyamqp://<user>:<password>@<broker-host>:5672/<vhost>\n"
           "or: export CELERY_BROKER_URL=pyamqp://...\nQA-Board's Docker Compose deployment has one: ask your QA-Board admins for an account.\n"
           f"Docs: {page}")
  else:
    fix = f"Check the broker URL ({source}), and that the broker runs: ask whoever runs it, often your QA-Board admins.\nDocs: {page}"
  from kombu import Connection  # type: ignore
  connection = Connection(broker_url, connect_timeout=timeout)
  try:
    host = connection.hostname
    port = connection.port or getattr(connection.transport, 'default_port', None)
    if host and port:
      try:
        socket.create_connection((host, int(port)), timeout=timeout).close()
      except socket.gaierror:
        return Check(name, ERROR, f"Can't reach the broker {masked} (from {source}): unknown host {host}.", fix=fix)
      except OSError as e:
        reason = "timed out" if isinstance(e, socket.timeout) else "connection refused" if isinstance(e, ConnectionRefusedError) else str(e)
        return Check(name, ERROR, f"Can't reach the broker {masked} (from {source}): {reason}.", fix=fix)
    try:
      connection.connect()
    except Exception as e:
      refused = 'ACCESS_REFUSED' in str(e) or 'NOT_ALLOWED' in str(e) or 'auth' in str(e).lower()
      reason = "it refused the account (user, password or virtual host)" if refused else f"{type(e).__name__}: {e}"
      return Check(name, ERROR, f"Can't connect to the broker {masked} (from {source}): {reason}.", fix=fix)
  finally:
    connection.release()
  return Check(name, OK, f"{masked} (from {source})")


def runs_queue(settings: Dict[str, Any]) -> str:
  """The queue where the runs' tasks go: task_routes for the qaboard task, else task_default_queue."""
  task_name = settings.get('qaboard_task_name', 'qaboard')
  routes = settings.get('task_routes')
  for table in (routes if isinstance(routes, (list, tuple)) else [routes]):
    if not isinstance(table, dict):
      continue
    for pattern, route in table.items():
      if fnmatch.fnmatchcase(task_name, str(pattern)):
        if isinstance(route, str):
          return route
        if isinstance(route, dict) and route.get('queue'):
          return str(route['queue'])
  return str(settings.get('task_default_queue') or 'celery')


def doctor_test_job(job_options: Dict[str, Any], timeout: float = 120) -> Iterable[Check]:
  """A worker runs a command that says where it runs, as who, if it sees the batch's folder and `qa`."""
  from types import SimpleNamespace
  from celery.exceptions import TimeoutError as CeleryTimeout  # type: ignore
  from ..checks import OK, WARNING, ERROR
  from ..doctor import make_test_dir, remove_test_dir
  from .celery_app import start
  name = "Celery test job"
  cwd = job_options.get('cwd') or os.getcwd()
  try:
    test_dir, existing = make_test_dir(job_options)
  except OSError as e:
    yield Check(name, ERROR, f"Can't create the test job's folder: {e}", fix="Fix the storage first (see above).")
    return
  result = test_dir / 'result.txt'
  try:
    command = f'echo "user: $(id -un)" > "{result}"; echo "host: $(hostname)" >> "{result}"; echo "qa: $(command -v qa || echo not found)" >> "{result}"'
    # The task only needs the job's command and cwd
    job = SimpleNamespace(run_context=SimpleNamespace(command=command, job_options={'cwd': cwd}))
    env = without_secrets(forward_secrets_option(job_options))
    async_result = start.apply_async(args=(job,), kwargs={'cwd': cwd, 'env': env})
    try:
      returncode = async_result.get(timeout=timeout)
    except CeleryTimeout:
      # also stops it if a worker started it
      async_result.revoke(terminate=True)
      yield Check(name, WARNING, f"The test task didn't end in {timeout:.0f}s: the workers may all be busy. qa doctor cancelled it.",
                  fix="See what they do: celery -A qaboard.runners.celery_app inspect active\nThen run qa doctor --test-job again.")
      return
    except Exception as e:
      yield Check(name, ERROR, f"The test task failed: {type(e).__name__}: {e}", fix="See the worker's logs.")
      return
    if not result.exists():
      yield Check(name, ERROR, f"A worker ran the test task (exit code {returncode}), but {result} isn't there: the workers don't see {test_dir.parent}, or {cwd}, at the same path.",
                  fix="The workers' machines must mount your project, inputs and results storage at the same paths as this machine.")
      return
    found = dict(line.split(': ', 1) for line in result.read_text(errors='replace').splitlines() if ': ' in line)
    where = f"on {found.get('host', '?')} as {found.get('user', '?')}"
    if found.get('qa', 'not found') == 'not found':
      yield Check(name, ERROR, f"A worker ran the test task {where}, but `qa` isn't on its PATH: the runs would fail.",
                  fix=("The runs get your environment, PATH included: run qa batch from the environment where qaboard is installed\n"
                       "(e.g. . .venv/bin/activate), and have this environment at the same path on the workers' machines."))
      return
    yield Check(name, OK, f"A worker ran the test task {where}, in {cwd}, and found {found['qa']}")
  finally:
    remove_test_dir(test_dir, existing)


class CeleryRunner(BaseRunner):
  type = "celery"

  def start(self, blocking=True, **kwargs):
    raise NotImplementedError

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    from celery import group
    from .celery_app import app, start
    app.conf.update(**{k: v for k, v in job_options.items() if k != 'forward_secrets'})

    # same as for the  local runner, but not sure it's necessary
    cwd = os.getcwd()
    if 'cwd' in job_options:
      os.chdir(job_options['cwd'])

    env = without_secrets(forward_secrets_option(job_options))

    # https://docs.celeryproject.org/en/stable/userguide/canvas.html#canvas-group
    command_id = job_options['command_id']
    nonce = uuid.uuid4().hex[:8]
    ids = [task_id(command_id, nonce, index) for index in range(len(jobs))]
    sent_task_ids.setdefault(command_id, []).extend(ids)
    g = group(start.s(job, cwd=cwd, env=env).set(task_id=id) for id, job in zip(ids, jobs))
    g.id = f"{command_id}-{nonce}"
    # stop_jobs revokes the tasks with this stamp
    if hasattr(g, 'stamp'):  # celery>=5.3
      g.stamp(**{COMMAND_ID_STAMP: command_id})
    result = g()

    # We could propagate=False to suppress exceptions, then
    # if hasattr(r, 'traceback') print(r.traceback)
    # but we don't expect exceptions running `qa run`, just return codes

    if blocking:
      # Runs may take a while, so just in case we receive SIGTERM/SIGINT,
      # We will cancel all the jobs we sent
      import signal
      def sigterm_handler(_signo, _stackframe):
        print('Aborted.')
        # the tasks that wait, and those that run
        CeleryRunner.stop_jobs(jobs, job_options)
        sys.exit(1)
      previous = {signum: signal.signal(signum, sigterm_handler) for signum in (signal.SIGTERM, signal.SIGINT)}
      try:
        result.get()
        # they're done: nothing to revoke anymore
        done = set(ids)
        sent_task_ids[command_id] = [id for id in sent_task_ids.get(command_id, []) if id not in done]
      finally:
        # e.g. `qa optimize` starts batches one after the other
        for signum, handler in previous.items():
          signal.signal(signum, handler)
    os.chdir(cwd)



  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False) -> Iterable[Check]:
    """Celery is installed, the broker answers, workers listen to the runs' queue. With test_job, a worker runs a command."""
    from ..checks import OK, ERROR
    from ..doctor import docs, mask_url_password
    page = docs('celery-integration')
    try:
      import celery  # type: ignore
    except ImportError:
      yield Check("Celery", ERROR, "Celery isn't installed.", fix=f"In the environment where you run qa:\n  pip install celery\nDocs: {page}")
      return
    yield Check("Celery", OK, f"celery {celery.__version__}")

    settings, broker_url, source = doctor_settings(job_options)
    broker = check_broker(broker_url, source, page)
    yield broker
    if broker.status != OK:
      return

    from .celery_app import app
    app.conf.update({**settings, 'broker_url': broker_url})
    inspect = app.control.inspect(timeout=3)
    start_worker = (f"Start one where your code, inputs and results storage are, with the same broker (and its real password):\n"
                    f"  pip install celery qaboard\n  export CELERY_BROKER_URL='{mask_url_password(broker_url)}'\n"
                    f"  celery -A qaboard.runners.celery_app worker --concurrency=10 --loglevel=info\nDocs: {page}#starting-celery-workers")
    try:
      pongs = inspect.ping() or {}
    except Exception as e:
      yield Check("Celery workers", ERROR, f"Couldn't ask the workers: {type(e).__name__}: {e}", fix=start_worker)
      return
    if not pongs:
      yield Check("Celery workers", ERROR, "No Celery worker answers on this broker.", fix=start_worker)
      return
    names = sorted(pongs)
    yield Check("Celery workers", OK, f"{len(names)} worker{'s' if len(names) != 1 else ''} answer{'s' if len(names) == 1 else ''}: {', '.join(names[:3])}{', ...' if len(names) > 3 else ''}")

    queue = runs_queue(settings)
    try:
      active = inspect.active_queues() or {}
    except Exception:
      active = {}
    listening = [w for w, queues in active.items() if any(isinstance(q, dict) and q.get('name') == queue for q in queues or [])]
    if not listening:
      yield Check("Celery queue", ERROR, f"No worker listens to the queue {queue!r}, where the runs go.",
                  fix=(f"Start workers that listen to it:\n  celery -A qaboard.runners.celery_app worker --queues {queue}\n"
                       f"or send the runs to the queues the workers listen to: runners.celery.task_routes in qaboard.yaml.\nDocs: {page}#advanced-celery-configuration"))
      return
    yield Check("Celery queue", OK, f"{len(listening)} worker{'s' if len(listening) != 1 else ''} listen{'s' if len(listening) == 1 else ''} to {queue!r}, where the runs go")

    if test_job:
      yield from doctor_test_job(job_options)


  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    """
    Stops the tasks of a `qa batch` command (job_options['command_id']): the workers drop those that wait, and kill
    those that run, with what they started (celery_app.start).
    It only needs the broker: runners.celery in job_options, else $CELERY_BROKER_URL. The QA-Board server calls it
    with only the type and command id, so it stops batches sent to its own broker (CELERY_BROKER_URL).
    Workers remember revoked tasks in memory: a worker that starts after this may still run the batch's waiting tasks,
    unless the workers keep their state (celery worker --statedb).
    """
    from celery import Celery  # type: ignore
    command_id = job_options['command_id']
    settings, broker_url, _ = doctor_settings(job_options)
    app = Celery('qaboard-stop', set_as_current=False)
    app.conf.update({**settings, 'broker_url': broker_url, 'broker_connection_timeout': 10})
    with app.connection_for_write() as connection:
      # fail instead of retrying forever if the broker is down: the server waits for us
      connection.ensure_connection(max_retries=2, timeout=10)
      control = app.control
      if hasattr(control, 'revoke_by_stamped_headers'):  # celery>=5.3
        control.revoke_by_stamped_headers({COMMAND_ID_STAMP: command_id}, terminate=True, connection=connection)
      # Workers older than Celery 5.3 don't know stamps. From the `qa batch` that sent them (Ctrl+C), we know the tasks.
      ids = sent_task_ids.get(command_id)
      if ids:
        control.revoke(list(ids), terminate=True, connection=connection)
