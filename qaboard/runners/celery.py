import os
from typing import List, Dict, Any

from .base import BaseRunner
from .job import Job
from ..run import RunContext 

class CeleryRunner(BaseRunner):
  type = "celery"

  def start(self, blocking=True, **kwargs):
    raise NotImplementedError

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    from celery import group
    from .celery_app import app, start
    app.conf.update(**job_options)

    # same as for the  local runner, but not sure it's necessary
    cwd = os.getcwd()
    if 'cwd' in job_options:
      os.chdir(job_options['cwd'])

    # https://docs.celeryproject.org/en/stable/userguide/canvas.html#canvas-group
    g = group(start.s(job, cwd=cwd) for job in jobs)
    # We set the group ID with our own UUID to make cancellation easier to manage
    g.id = job_options['command_id']
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
        g.revoke()
        exit(1)
      signal.signal(signal.SIGTERM, sigterm_handler)
      signal.signal(signal.SIGINT, sigterm_handler)

      results = result.get()
    os.chdir(cwd)



  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    raise NotImplementedError
    # TODO: not sure whether we should .revoke(terminate=True)
    # TODO: one of the options below should work, but I don't have time to test it right now...

    # http://docs.celeryproject.org/en/latest/userguide/workers.html#worker-persistent-revokes
    from celery.result import AsyncResult
    AsyncResult(job_options['command_id']).revoke()

    # https://docs.celeryproject.org/en/stable/reference/celery.result.html
    from celery.result import GroupResult
    g = GroupResult(id=job_options['command_id'])

    # https://stackoverflow.com/questions/13685344/retrieving-groupresult-from-taskset-id-in-celery
    # We may need to call result.save() in the task above for it to work...
    from celery.result import GroupResult
    result = GroupResult.restore(job_options['command_id'])
    result.revoke()

    from celery.task.control import revoke
    revoke(job_options['command_id'])
