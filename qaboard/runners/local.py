import os
import sys
import time
import shlex
import shutil
import signal
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Iterable

import click

from .base import BaseRunner
from .job import Job
from ..run import RunContext
from ..checks import Check


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


  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False) -> Iterable[Check]:
    from ..checks import OK, WARNING, ERROR
    from ..doctor import docs, run_command, tail
    page = docs('local-multiprocessing')
    cpus = os.cpu_count() or 1
    snippet = "runners:\n  local:\n    concurrency: -1   # 1=one at a time, 4=four at a time, -1=one per CPU, -2=all CPUs but one"
    name = "Local runs at the same time"
    concurrency = job_options.get('concurrency')
    try:
      concurrency = int(concurrency) if concurrency is not None else None
      # like joblib's n_jobs: only 0 is invalid, negative values count from the number of CPUs, at least 1
      if concurrency == 0:
        raise ValueError
    except (TypeError, ValueError):
      yield Check(name, ERROR, f"concurrency: {concurrency!r} isn't valid.", fix=f"In qaboard.yaml (or QA_BATCH_CONCURRENCY, or qa batch --local-concurrency):\n{snippet}\nDocs: {page}")
    else:
      if concurrency is None or concurrency == 1:
        yield Check(name, OK, f"one run at a time, on {cpus} CPUs here. To run more at once: qa batch --local-concurrency -1 (one per CPU)")
      elif concurrency > cpus:
        yield Check(name, WARNING, f"{concurrency} at the same time, but there are {cpus} CPUs here: the runs compete for them.", fix=f"Use -1 for one run per CPU:\n{snippet}")
      else:
        runs = concurrency if concurrency > 0 else max(1, cpus + 1 + concurrency)
        detail = f" ({concurrency}: all {cpus} CPUs here{f' but {-concurrency - 1}' if concurrency < -1 else ''}, at least 1)" if concurrency < 0 else f", on {cpus} CPUs here"
        yield Check(name, OK, f"{runs} at the same time{detail}")

    timeout = job_options.get('timeout')
    try:
      timeout = float(timeout or 0)
      if timeout < 0:
        raise ValueError
    except (TypeError, ValueError):
      yield Check("Local runs timeout", ERROR, f"timeout: {timeout!r} isn't valid: use seconds, or 0 for no timeout.",
                  fix=f"In qaboard.yaml (or QA_BATCH_TIMEOUT, or qa batch --local-timeout):\nrunners:\n  local:\n    timeout: 3600   # seconds\nDocs: {page}")
    else:
      if timeout:
        yield Check("Local runs timeout", OK, f"runs are stopped after {timeout:g}s")

    # `qa batch` starts each run with `qa run ...` in a shell (python -m qaboard in our tests)
    testing = 'QA_TESTING' in os.environ
    qa_path = shutil.which('qa')
    if not qa_path and not testing:
      yield Check("qa command", ERROR, "`qa` isn't on the PATH: `qa batch` starts each run with a `qa run` command.",
                  fix=f"Activate the environment where qaboard is installed (e.g. . .venv/bin/activate), or install it:\n  pip install qaboard\nDocs: {docs('installation')}")
      return
    if qa_path:
      here = Path(sys.executable).parent
      if Path(qa_path).parent != here and not testing and (here / 'qa').exists():
        yield Check("qa command", WARNING, f"The runs would use {qa_path}, not the qa of this Python ({here / 'qa'}).",
                    fix=f"Put this environment first on the PATH, e.g.: export PATH=\"{here}:$PATH\"")
      else:
        yield Check("qa command", OK, qa_path)

    if test_job:
      cwd = job_options.get('cwd') or os.getcwd()
      command = f"{shlex.quote(sys.executable)} -m qaboard --help" if testing else "qa --help"
      start = time.time()
      returncode, output = run_command(command, timeout=120, cwd=cwd)
      elapsed = time.time() - start
      if returncode is None:
        yield Check("Test job", ERROR, f"`{command}` didn't end in 2 minutes, in {cwd}.", fix=f"Run it yourself to see where it hangs:\n  cd {shlex.quote(cwd)} && {command}")
      elif returncode != 0 or 'Usage:' not in output:
        yield Check("Test job", ERROR, f"`{command}` failed in {cwd} (exit code {returncode}):\n{tail(output)}", fix=f"Run it yourself:\n  cd {shlex.quote(cwd)} && {command}")
      else:
        yield Check("Test job", OK, f"`{command}` ran in {cwd}, in {elapsed:.1f}s")