import os
import sys
import time
import psutil
import subprocess
from typing import Optional

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

  pipe = subprocess.PIPE
  # print("job.run_context.command", job.run_context.command)
  # print("env", env)
  with subprocess.Popen(job.run_context.command, shell=True,
                        encoding='utf-8',
                        # Avoid issues with code outputting malformed unicode
                        # https://docs.python.org/3/library/codecs.html#error-handlers
                        errors='surrogateescape',
                        cwd=cwd if cwd else job.run_context.job_options['cwd'],
                        env=env,
                        stdout=pipe, stderr=pipe) as process:
    for line in process.stdout:
      print(line, end='')
    process.wait()
    return process.returncode




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


