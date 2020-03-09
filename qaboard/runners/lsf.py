"""
Utilities to communicate with SIRC's LSF cluster.

If you run into issues with LSF
- Search for IBM LSF's documentation online
- Be aware our IT overwrites LSF utilities (eg bsub...) with custom wrappers.
  Read them as they change environment variables.

Note:
- Windows compatibility is not garanteed since we rely on shell features (heredocs) and 
"""
import os
import subprocess
from pathlib import Path
from dataclasses import dataclass, fields, replace, asdict
from typing import Optional, List, Dict, Any, cast

from click import secho

from .base import BaseRunner
from .job import Job
from ..run import RunContext
from ..api import get_output
from ..utils import getenvs



class LsfPriority:
  LOW    = 1000
  NORMAL = 2000
  HIGH   = 4000


@dataclass
class LsfOptions():
  project: Optional[str] = None
  queue: Optional[str] = None
  fast_queue: Optional[str] = None
  priority: int = LsfPriority.NORMAL
  max_threads: int = 0
  max_memory: int = 0 #in MB
  resources: Optional[str] = None
  # not strictly LSF options, but important to send jobs
  user: Optional[str] = getenvs(('USERNAME', 'USER'))
  cwd: Path = Path() # current working directory
  # The QA-Board server will try to start or kill jobs,
  # but it runs in a container, and does not have direct access to LSF.
  # Thus we need to SSH to a bridge host first, then change user to have permission to kill any job (being LSF admin would help...).   :/
  # To implement this logic in a not-too-hardcoded way, users can provide a 
  bridge: str = os.environ.get('QA_RUNNERS_LSF_BRIDGE', '')
  # as a format string, e.g.
  #   "ssh my-bridge-host {bsub_command}"
  #   "sss my-bridge-host su {user} {bsub_command}"
    

# We'll filter user-provided options, keeping only known ones
lsf_option_names = set(f.name for f in fields(LsfOptions))

def dict_to_LsfOptions(job_options):
  # "Easy" way to inherit documented defaults and get dot accessors...
  options = LsfOptions()
  filtered_options = {k:v for k,v in job_options.items() if k in lsf_option_names}
  return replace(options, **filtered_options)


class LsfRunner(BaseRunner):
  """Start jobs using the LSF task management system."""
  type = "lsf"

  def __init__(self, run_context : RunContext):
    self.run_context = run_context
    # aliases for  quick access
    self.output_dir: Optional[Path] = run_context.output_dir
    self.command = run_context.command

    self.options = dict_to_LsfOptions(run_context.job_options)
    # We've find it useful to dial back the priority if tuning jobs
    self.options.priority = LsfPriority.LOW if run_context.extra_parameters else LsfPriority.NORMAL


  @property
  def name(self):
    # We want a unique job name, with the same prefix as other related jobs
    # so that's it's easy to list/kill them together
    job_prefix = f"{self.run_context.job_options['command_id'][:8]}/"
    output_dir_slug = f"{self.output_dir}".replace(" ", "-").replace('"','') if self.output_dir else ''
    return f"{job_prefix}{output_dir_slug}"


  def start(self, blocking=True, name: Optional[str] = None, flags: str = ''):
    """Sends a job to the LSF queue and returns the results of the subprocess call that sent the command to LSF.
    The `dependencies` parameter specifies jobs that must be exited (any error code is OK) before this one.
    """
    fast_queue = self.options.fast_queue if self.options.fast_queue else self.options.queue
    queue = self.options.queue if blocking else fast_queue

    # In our cluster, we have filessytem sync issues, and LSF does't print live logs.
    # So here we save STDOUT to log.lsf.txt, while we log in real-time log.txt ourselves
    # Ideally we should copy the actual LSF logs after the job, since they have STDOUT and a summary header
    lsf_log_file = (self.output_dir / "log.lsf.txt").resolve() if self.output_dir else None
    bsub_command = " ".join(
      [
        # When running without a TTY (usually under su/sudo)
        # LSF fails to write to stdout and sends mails instead...
        "LSB_JOB_REPORT_MAIL=N" if blocking else "",
        # Less verbosity
        "LSB_INTERACT_MSG_ENH=N",
        "bsub",
        # Not needed since LSF is configured to re-use the current working directory,
        # Mounted and available from all hosts on the network.
        f'-cwd "{os.getcwd()}"' if self.options.bridge else '',
        # Note: for our current use-cases, -K should be enough, but it's still nice to get STDOUT logs
        "-I" if blocking else "",
        f"-P '{self.options.project}'",
        f"-q '{queue}'",
        f'-J "{name if name else self.name}"',
        f"-sp {self.options.priority}",
        f'-o "{lsf_log_file}"' if lsf_log_file else '', 
        # It would be nice to overwrite our logs with LSF's, which include a nice header
        # But we've had issues with filesystem sync, and found that LSF would somethings have no logs(?!?) 
        # f'-Ep \'sleep 30 ; mv "{lsf_log_file}" "{log_file}"\'',
        # TODO: we could ask those threads to be on the same cores...
        f"-R \"affinity[thread({self.options.max_threads})]\"" if self.options.max_threads > 0 else "",
        f"-R \"rusage[mem={self.options.max_memory}]\"" if self.options.max_memory > 0 else "",
        f"-R \"{self.options.resources}\"" if self.options.resources else '',
        flags,
        '<< "EOF"\n'
        # the click python package hates ascii locales, for good reasons
        "  LC_ALL=en_US.utf8 LANG=en_US.utf8",
        # forces a non-interactive matplotlib backend
        "MPLBACKEND=agg",
        self.command if self.command else 'echo OK',
        "\nEOF",
      ]
    )
    if 'QA_BATCH_VERBOSE' in os.environ:
      secho(bsub_command, dim=True, err=True)

    # This needs to be set at the cluster level
    # Anyway it's easier to handle live logs ourselves
    # https://www.ibm.com/support/knowledgecenter/en/SSWRJV_10.1.0/lsf_config_ref/lsf.conf.lsb_stdout_direct.5.html
    # os.environ['LSB_STDOUT_DIRECT'] = 'Y'

    bridge_bsub_command = self.options.bridge.format(**asdict(self.options), bsub_command=bsub_command)
    out = subprocess.run(
      bsub_command if not bridge_bsub_command else bridge_bsub_command,
      shell=True,
      encoding="utf-8",
      stdout=subprocess.PIPE,
      stderr=subprocess.PIPE,
    )
    if 'QA_BATCH_VERBOSE' in os.environ:
      secho(out.stdout, dim=True, err=True)
      secho(out.stderr, dim=True, err=True)
    try:
      out.check_returncode()
    except:
      secho(out.stdout, err=True)
      secho(out.stderr, err=True)
      raise Exception("Failed to send jobs to LSF")
    return out


  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    # start asynchronously the jobs 
    for job in jobs:
      job.start(blocking=False)

    if blocking:
      # Runs may take a while, so just in case we receive SIGTERM/SIGINT,
      # We will cancel all the jobs we sent
      import signal
      def sigterm_handler(_signo, _stackframe):
        print('Aborted.')
        LsfRunner.stop_jobs(jobs, job_options)
        exit(1)
      signal.signal(signal.SIGTERM, sigterm_handler)
      signal.signal(signal.SIGINT, sigterm_handler)


      # We create a job that will just wait for the others
      from copy import deepcopy
      waiting_job = deepcopy(jobs[0])
      waiting_job.runner = cast(LsfRunner, waiting_job.runner) # we'll never mix runners
      waiting_job.runner.options = dict_to_LsfOptions(job_options)
      waiting_job.runner.command = 'echo Done'
      waiting_job.runner.output_dir = None # disable logging
      lsf_job_prefix = f"{job_options['command_id'][:8]}/"
      waiting_job.start(blocking=True, name=f'{lsf_job_prefix}WAIT', flags=f'-w "ended({lsf_job_prefix}*)"')

      # Our shared storage takes a while to sync when using LSF. It should be solved, and this sleep removed...
      if not all([j.id for j in jobs]): # if we can read the status from the database, no sync issue
        import time
        time.sleep(1) # seconds


  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
      # We could dot this to be sure we explicitely kill all jobs 
      #   command = " && ".join([f"bkill -J {job.name} 0" for job in jobs])
      # But we're only sending jobs as part of a single command...
      bkill = f"bkill -J '{job_options['command_id'][:8]}/*'"
      secho(bkill, bold=True, err=True)
      
      bridge_bkill = job_options.get('bridge', '').format(**job_options, bsub_command=bkill)
      out = subprocess.run(
          bkill if not job_options.get('bridge') else bridge_bkill,
          shell=True,
          encoding="utf-8",
          stdout=subprocess.PIPE,
          stderr=subprocess.STDOUT,
      )
      try:
        out.check_returncode()
        secho(out.stdout, err=True)
      except:
        # If LSF can't find the jobs, they are likely done already
        if 'No match' not in str(out.stdout):
          return out.stdout
