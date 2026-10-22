import os
import signal
import subprocess
from typing import List, Dict, Any

import click

from .base import BaseRunner
from .job import Job
from ..run import RunContext


class LocalRunner(BaseRunner):
  type = "local"
  # Batches with their own run one after the other (BaseRunner.start_groups)
  group_options = ('concurrency', 'timeout')

  def __init__(self, run_context : RunContext):
    self.run_context = run_context


  def start(self, blocking=True, cwd=None, timeout=None):
    # With a timeout, the run gets its own process group, so that we can kill the shell and what it started
    own_group = bool(timeout) and os.name != 'nt'
    process = subprocess.Popen(
      self.run_context.command, shell=True,
      encoding='utf-8',
      # Avoid issues with code outputting malformed unicode
      # https://docs.python.org/3/library/codecs.html#error-handlers
      errors='surrogateescape',
      cwd=cwd if cwd else self.run_context.job_options['cwd'],
      start_new_session=own_group,
    )
    try:
      return process.wait(timeout=timeout or None)
    except subprocess.TimeoutExpired:
      # The run is still pending: JobGroup.start marks it as failed
      click.secho(f'[ERROR] {self.run_context.rel_input_path}: killed after its timeout of {timeout}s', fg='red', bold=True, err=True)
      if own_group:
        os.killpg(process.pid, signal.SIGKILL)
      else:
        process.kill()
      return process.wait()

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
      if not blocking:
        click.secho(f'WARNING: We currently dont support non-blocking local runs.', fg='yellow', err=True)

      from joblib import Parallel, delayed
      # multiprocessing will try to reimport qaboard, which relies on the CWD
      cwd = os.getcwd()
      if 'cwd' in job_options:
        os.chdir(job_options['cwd'])
      # Jobs only wait on a subprocess, so threads are enough. Process-based workers
      # also linger after the batch, and blocked the exit of `qa` when it was itself a subprocess.
      # Each run has its own timeout (0/None: none): joblib's would fail the batch and leave the run pending
      timeout = job_options.get('timeout') or None
      Parallel(
        prefer="threads",
        n_jobs=job_options.get('concurrency'),
        verbose=int(os.environ.get('QA_BATCH_VERBOSE', 0)),
      )(delayed(lambda j: j.start(cwd=cwd, timeout=timeout))(j) for j in jobs)
      os.chdir(cwd)


  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    # Local runs happen on the machine that started them, the server can't stop them.
    # We don't raise: when users stop a batch in the web app, the server then marks its pending runs as stopped.
    return None