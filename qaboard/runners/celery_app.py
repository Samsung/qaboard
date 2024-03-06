import os
import sys
import time
import psutil
import subprocess
from typing import Optional

from celery import Celery
sys.path.append(os.path.dirname(__file__))
import celeryconfig


app = Celery('celery_app')
app.config_from_object(celeryconfig)

from qaboard.config import config
celery_config = config.get('runners', {}).get('celery', {})
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
                        # Avoid issues with code outputing malformed unicode
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
        except:
            pass


# Make it possible to use QA-Board's pool of celery worker
# from other applications that expect to ssh directly to those hosts
@app.task(name='ssh_task', serializer='json')
def ssh_task(id):
    tries = 10
    ssh = None
    while tries:
        ssh = find_process("ID", id)
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


