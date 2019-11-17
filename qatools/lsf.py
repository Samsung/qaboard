"""
Utilities to communicate with SIRC's LSF cluster.

If you run into issues with LSF
- Search for IBM LSF's documentation online
- Be aware our IT overwrites LSF utilities (eg bsub...) with custom wrappers.
  Read them as they change environment variables.  
"""
import os
import sys
import subprocess
import time
import json
from pathlib import Path
from dataclasses import dataclass, replace

import click

from .api import get_output
from .utils import getenvs

# We avoid hosts that run on old processors lacking AVX instructions (pre-Sandy Bridge)
# We could avoid those that lack AVX2, and someday we'll care about AVX512...
# All possible selectable CPU types can be read at /lsf_top/conf/lsf.cluster.lsf
# old_cpu_architectures = ["IBMX5667", "IBMX5570", "IBMX5690"]
# resources = " && ".join([f"!(model=={arch})" for arch in old_cpu_architectures])

class LsfPriority:
  LOW, NORMAL, HIGH = 1000, 2000, 4000

@dataclass
class LsfConfig:
  project: str = None
  queue: str = None
  fast_queue: str = None
  priority: int = LsfPriority.NORMAL
  max_threads: int = 0
  max_memory: int = 0 #in MB
  resources: str = None


class Job:
  """Wraps LSF jobs for convenience."""

  def __init__(self, name, command="", output_directory=Path().resolve(), lsf_config_dict=None):
    self.name = str(name).replace(" ", "-").replace('"','')
    self.command = command
    self.output_directory = output_directory
    self.log_file = output_directory / "log.txt"

    self.lsf_config = LsfConfig()
    if lsf_config_dict:
      self.lsf_config = replace(self.lsf_config, **lsf_config_dict)

    # Id of the corresponding Output in the qatools database
    self.id = None


  def is_failed(self):
    if self.id:
      output_db = get_output(self.id)
      failed = not output_db or output_db["is_failed"]
      if failed:
        click.secho(f'ERROR: At least a run crashed... {self.output_directory}', fg='red', err=True)
      return failed
    else:
      metrics_file = self.output_directory / 'metrics.json'
      if not metrics_file.exists():
        click.secho(f'ERROR: A run crashed: could not find {metrics_file}', fg='red', err=True)
        return True
      with metrics_file.open() as f:
        metrics = json.load(f)
        if metrics['is_failed']:
          click.secho(f"ERROR: Failed run! More info at: {self.output_directory}/log.txt", fg='red', err=True)
          return True


 
  def run_local(self, cwd):
    with subprocess.Popen(self.command, shell=True,
                          encoding='utf-8',
                          # Avoid issues with code outputing malformed unicode
                          # https://docs.python.org/3/library/codecs.html#error-handlers
                          errors='surrogateescape',
                          cwd=cwd,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
      for line in iter(process.stdout.readline, ''):
        print(line, end='')
      process.wait()
      return process.returncode

  def run_lsf(self, dependencies=None, interactive=False):
    """Sends a job to the LSF queue and returns the results of the subprocess call that sent the command to LSF.
    The `dependencies` parameter specifies jobs that must be exited (any error code is OK) before this one.
    """
    if dependencies:
      dependencies_expression = " && ".join([f"ended({job.name})" for job in dependencies])
      dependencies_flag = f'-w "{dependencies_expression}"'
    else:
      dependencies_flag = ""

    queue = self.lsf_config.queue if not interactive else self.lsf_config.fast_queue
    q_command = " ".join(
      [
        # When running without a TTY (usually under su/sudo)
        # LSF fails to write to stdout and sends mails instead...
        "LSB_JOB_REPORT_MAIL=N" if interactive else "",
        "bsub",
        # only necessary if we send the job through ssh
        # f'-cwd "{os.getcwd()}"',
        # note: we don't request a pseudoterminal here -Is
        # on our current use-cases, -K should be enough
        "-I" if interactive else "",
        f"-P {self.lsf_config.project}",
        f"-q {queue}",
        f"-sp {self.lsf_config.priority}",
        f'-J "{self.name}"',
        # Since we log ourselves and LSF will want to print a other report, overwrite the log file
        f'-oo "{self.log_file}"',
        f"-R \"affinity[thread({self.lsf_config.max_threads})]\"" if self.lsf_config.max_threads > 0 else "",
        f"-R \"rusage[mem={self.lsf_config.max_memory}]\"" if self.lsf_config.max_memory > 0 else "",
        f"-R \"{self.lsf_config.resources}\"" if self.lsf_config.resources else '',
        dependencies_flag,
        '<< EOF\n'
        # the click python package hates ascii locales, for good reasons
        "  LC_ALL=en_US.utf8 LANG=en_US.utf8",
        # forces a non-interactive matplotlib backend
        "MPLBACKEND=agg",
        self.command,
        "\nEOF",
      ]
    )
    if 'QATOOLS_BATCH_VERBOSE' in os.environ:
      click.secho(q_command, dim=True)
    os.environ['LSB_INTERACT_MSG_ENH'] = 'N'
    # https://www.ibm.com/support/knowledgecenter/en/SSWRJV_10.1.0/lsf_config_ref/lsf.conf.lsb_stdout_direct.5.html
    os.environ['LSB_STDOUT_DIRECT'] = 'Y'

    # print(q_command)
    out = subprocess.run(
      q_command,
      shell=True,
      encoding="utf-8",
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
    )
    # print(out)
    # click.secho(out.stdout)
    return out



def run_jobs_lsf(jobs, runner, no_wait=True, lsf_jobs_prefix=None, lsf_config=None, waiting_job_name=None):
  for job in jobs:
    job.run_lsf()

  if not no_wait:
    waiting_job = [Job(f"{lsf_jobs_prefix}*", lsf_config_dict=lsf_config)]
    # in case we receive SIGTERM/SIGINT, we cancel all remaining sent jobs
    import signal
    def sigterm_handler(_signo, _stackframe):
      print('Aborted.')
      kill_jobs_lsf(waiting_job, via_lsf=True)
      exit(1)
    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT, sigterm_handler)

    wait = Job(waiting_job_name, 'echo "Done."', lsf_config_dict=lsf_config)
    wait.run_lsf(interactive=True, dependencies=waiting_job)
 

def run_jobs_local(jobs, config, ctx):
  from joblib import Parallel, delayed
  n_jobs = config.get('runners', {}).get('local', {}).get('concurrency', -1)
  verbose = int(os.environ.get('QATOOLS_BATCH_VERBOSE', 0))
  # multiprocessing will try to reimport qatools, which relies on the CWD
  cwd = os.getcwd()
  if 'previous_cwd' in ctx.obj:
    os.chdir(ctx.obj['previous_cwd'])
  Parallel(n_jobs=n_jobs, verbose=verbose)(delayed(lambda j: j.run_local(cwd=cwd))(j) for j in jobs)
  os.chdir(cwd)


def run_jobs(jobs, runner, no_wait=True, lsf_jobs_prefix=None, lsf_config=None, waiting_job_name=None, delay_before_status_check=0, config=None, ctx=None):
  if runner == 'lsf':
    run_jobs_lsf(jobs, runner, no_wait, lsf_jobs_prefix, lsf_config, waiting_job_name)
    if delay_before_status_check:
      time.sleep(delay_before_status_check)

  if runner == 'local':
    if no_wait:
      click.secho(f'WARNING: --no-wait is not supported for local runs', fg='yellow', err=True)
    run_jobs_local(jobs, config, ctx)

  is_failed = False
  for job in jobs:
    is_failed = is_failed or job.is_failed()
  return is_failed


def kill_jobs_lsf(jobs, via_lsf=False):
    command = " && ".join([f"bkill -J {job.name} 0" for job in jobs])
    if True:
        killer = Job(f"killer", f'"{command}"', lsf_config_dict={'priority': LsfPriority.HIGH})
        killer.send()
    else:
        out = subprocess.run(
            command,
            shell=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        click.secho(out.stdout)
        return out



def get_running_lsf_jobs():
  """
  Return the names of the running LSF jobs for the current user (as a set)
  From Windows we return an empty set, but if you really want to, you should be able to find a way to connect to LSF.
  """
  if os.name=='nt':
      return set()

  user = getenvs(('USERNAME', 'USER', 'HOSTNAME', 'HOST'))
  cmd = " ".join(["bjobs -u", user, "-noheader -o 'job_name:100'"])
  out = subprocess.run(cmd, stdout=subprocess.PIPE, shell=True, encoding="utf-8")
  if out.stdout:
      lines = out.stdout.split("\n")
      # the output begins with *
      job_names = [l.strip()[1:] for l in lines]
      return set(job_names)
  else:
      return set()


def job_ran_once(output_directory):
  return (output_directory / 'metrics.json').exists()


def job_is_failed(output_directory):
  metrics_path = output_directory / 'metrics.json'
  is_done = metrics_path.exists()
  if is_done:
    with metrics_path.open() as f:
      return json.load(f).get('is_failed', True)
  else:
    return False
