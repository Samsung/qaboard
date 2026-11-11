import os
import sys
import time
import signal
import psutil
import subprocess
from typing import Optional
from contextlib import contextmanager

from celery import Celery, signals
sys.path.append(os.path.dirname(__file__))
import celeryconfig


@signals.celeryd_init.connect
def init_sentry(**kwargs):
  """
  Workers report errors and traces to Sentry: to $SENTRY_DSN, else to the site's QABOARD_SENTRY_DSN, if any.
  celeryd_init runs in the worker's main process, before the pool's processes fork from it (Sentry's docs).
  """
  from qaboard.site_config import site_config
  dsn = os.environ.get('SENTRY_DSN') or site_config('QABOARD_SENTRY_DSN')
  if not dsn:
    return
  import sentry_sdk
  from sentry_sdk.integrations.celery import CeleryIntegration
  from qaboard import __version__
  from qaboard.sentry_utils import sentry_options
  ca_setting = os.environ.get('SENTRY_CA_CERTS') or site_config('SENTRY_CA_CERTS') or site_config('QABOARD_SENTRY_VERIFY')
  sentry_sdk.init(**sentry_options(
    dsn,
    release=f"qaboard@{__version__}",
    ca_setting=ca_setting,
    integrations=[CeleryIntegration()],
  ))


app = Celery('celery_app')
app.config_from_object(celeryconfig)

from qaboard.config import config
from qaboard.runners.celery_settings import celery_settings
celery_config = celery_settings(config)
app.conf.update(**celery_config)



@app.task(bind=True, name=celery_config.get('qaboard_task_name', "qaboard"))
def start(self, job, cwd=None, env=None):
  # https://docs.celeryproject.org/en/stable/userguide/tasks.html#task-request-info
  print('Executing task id {0.id}, groupID: {0.group}'.format(self.request))

  # The command runs in its own process group: when the task is revoked with terminate=True (stopping the batch),
  # the worker's pool sends SIGTERM to the process that runs this task, and we stop all that the command started.
  with subprocess.Popen(job.run_context.command, shell=True,
                        encoding='utf-8',
                        # Avoid issues with code outputting malformed unicode
                        # https://docs.python.org/3/library/codecs.html#error-handlers
                        errors='surrogateescape',
                        cwd=cwd if cwd else job.run_context.job_options['cwd'],
                        # The worker's environment (its own secrets, CUDA_VISIBLE_DEVICES...), with qa batch's on top:
                        # qa batch doesn't forward its secrets, workers can provide them.
                        env={**os.environ, **env} if env is not None else None,
                        start_new_session=os.name != 'nt',
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
    with stopped_with_task(process):
      for line in process.stdout:
        print(line, end='')
      process.wait()
    return process.returncode


def kill_process_group(process: subprocess.Popen, grace: float = 5):
  """Stops the command and what it started (its process group): SIGTERM, then SIGKILL after `grace` seconds"""
  if os.name == 'nt' or process.poll() is not None:
    return
  try:
    os.killpg(process.pid, signal.SIGTERM)
  except OSError:
    return
  try:
    process.wait(timeout=grace)
  except subprocess.TimeoutExpired:
    pass
  try:
    # also what's left in the group after the shell exited
    os.killpg(process.pid, signal.SIGKILL)
  except OSError:
    pass


def in_pool_process() -> bool:
  """
  Whether the task runs in one of the prefork pool's processes: only there does a SIGTERM mean "terminate this task"
  (revoke(terminate=True) signals the pool process that runs it). With --pool=solo or threads, tasks run in the
  worker's main process, where SIGTERM is the worker's warm shutdown: it waits for the running tasks, we let them
  finish (and those pools can't terminate tasks). Like Celery's own signal handlers, we tell from the process's name.
  """
  try:
    from billiard.process import current_process
    return current_process().name != 'MainProcess'
  except Exception:
    return False


@contextmanager
def stopped_with_task(process: subprocess.Popen):
  """
  When the task is terminated (SIGTERM, or billiard's TERM_SIGNAME), or fails, the command's process group is killed.
  Only in the prefork pool's processes: elsewhere SIGTERM is the worker's, see in_pool_process.
  """
  if not in_pool_process():
    try:
      yield
    finally:
      kill_process_group(process, grace=1)
    return
  term_signals = {signal.SIGTERM}
  try:
    from billiard.common import TERM_SIGNAL
    term_signals.add(TERM_SIGNAL)
  except ImportError:
    pass

  def terminate(signum, frame):
    kill_process_group(process)
    # then die like the pool expects
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)

  previous = {}
  for signum in term_signals:
    try:
      previous[signum] = signal.signal(signum, terminate)
    except ValueError:  # not in the main thread (e.g. --pool=threads): termination isn't supported there anyway
      pass
  try:
    yield
  finally:
    for signum, handler in previous.items():
      signal.signal(signum, handler)
    kill_process_group(process, grace=1)




def find_process(env_key, env_value) -> Optional[psutil.Process]:
    """Returns the process that includes a given environment variable."""
    # Since the pids are sorted, it supports cases where the task spawns short-lived processes
    for pid in psutil.pids():
        try:
            p = psutil.Process(pid)
            with p.oneshot(): # caches internal calls  
              if p.environ().get(env_key) == env_value:
                print(f"{p.name()}", ' '.join(p.cmdline()))
                return p
        except Exception:
            pass
    return None


# Make it possible to use QA-Board's pool of celery worker
# from other applications that expect to ssh directly to those hosts
@app.task(name='ssh_task', serializer='json')
def ssh_task(id):
    tries = 30
    ssh = None
    while tries:
        ssh = find_process("WEBCDE_CONNECTION_ID", id)
        if ssh:
            break
        tries -= 1
        time.sleep(1)
        print(f"Waiting for SSH ({id})...")
    if not ssh:
        return
    print(f"SSH started ({id})")
    ssh.wait()
    print(f"SSH finished ({id})")


