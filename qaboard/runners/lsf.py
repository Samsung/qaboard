"""
Utilities to communicate with SIRC's LSF cluster.

If you run into issues with LSF
- Search for IBM LSF's documentation online
- Be aware our IT overwrites LSF utilities (eg bsub...) with custom wrappers.
  Read them as they change environment variables.

Note:
- Windows compatibility is not garanteed since we rely on shell features (heredocs) and 
"""
import re
import os
import random
import string
import subprocess
import time
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
  priority: int = LsfPriority.NORMAL
  max_threads: int = 0
  max_memory: int = 0 #in MB
  resources: Optional[str] = None
  options: Optional[str] = None
  # Max number of jobs from the same `qa batch` running at the same time. 0 = unlimited.
  concurrency: int = 0
  # How we enforce `concurrency`:
  # - "array": jobs sharing the same bsub options are sent as 1 job array with a slot limit (-J "name[1-n]%concurrency").
  #            It's a sliding window, and a single bsub call instead of 1 per job.
  # - "waves": jobs are sent in waves of `concurrency` jobs, each wave waiting for the previous one to end.
  #            Stragglers block the next wave, use only if job arrays don't work for you.
  concurrency_strategy: str = "array"
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
  filtered_options = {k:v for k,v in job_options.items() if k in lsf_option_names and v is not None}
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
    # In some cases we want to use the LSF job name as docker container job name,
    # It imposes restrictions on the length and characters we can use... 
    # We want a unique job name, with the same prefix as other related jobs
    # so that's it's easy to list/await/kill them together
    batch_prefix = self.run_context.job_options['command_id'][:8]
    # we generate a random string for the run
    # We used to include self.output_dir in the name, but it's too long and not super readable anyway
    # if you need to know what job runs what, it is better to print the command or the log file
    random_str = ''.join((random.choice(string.ascii_lowercase) for _ in range(12)))
    return f"{batch_prefix}_{random_str}"


  def start(self, blocking=True, name: Optional[str] = None, flags: str = ''):
    """Sends a job to the LSF queue and returns the results of the subprocess call that sent the command to LSF.
    Use `flags` for extra bsub flags, e.g. dependencies like `-w "ended(my_job_name)"`.
    """
    # In our cluster, we have filessytem sync issues, and LSF does't print live logs.
    # So here we save STDOUT to log.lsf.txt, while we log in real-time log.txt ourselves
    # Ideally we should copy the actual LSF logs after the job, since they have STDOUT and a summary header
    lsf_log_file = (self.output_dir / "log.lsf.txt").resolve() if self.output_dir else None
    script = " ".join([
      # the click python package hates ascii locales, for good reasons
      "  LC_ALL=en_US.utf8 LANG=en_US.utf8" if self.command else '  ',
      # forces a non-interactive matplotlib backend
      "MPLBACKEND=agg" if self.command else '',
      self.command if self.command else 'echo OK',
    ])
    return self.bsub(
      script=script,
      name=name if name else self.name,
      log_file=lsf_log_file,
      blocking=blocking,
      flags=flags,
    )


  def bsub_options(self) -> List[str]:
    """bsub flags describing where/how a job runs. Jobs with identical options can be grouped in a job array."""
    return [
      f"-P '{self.options.project}'",
      f"-q '{self.options.queue}'",
      f"-sp {self.options.priority}",
      # TODO: we could ask those threads to be on the same cores...
      f"-R \"affinity[thread({self.options.max_threads})]\"" if self.options.max_threads > 0 else "",
      f"-R \"rusage[mem={self.options.max_memory}]\"" if self.options.max_memory > 0 else "",
      f"-R \"{self.options.resources}\"" if self.options.resources else '',
      self.options.options if self.options.options else '',
    ]


  def bsub(self, script: str, name: str, log_file: Optional[Path] = None, blocking=False, flags: str = ''):
    """Runs bsub (via the bridge if any), with retries. `script` is sent via a heredoc."""
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
        f'-J "{name}"',
        f'-o "{log_file}"' if log_file else '',
        # It would be nice to overwrite our logs with LSF's, which include a nice header
        # But we've had issues with filesystem sync, and found that LSF would somethings have no logs(?!?)
        # f'-Ep \'sleep 30 ; mv "{lsf_log_file}" "{log_file}"\'',
        *self.bsub_options(),
        flags,
        '<< "EOF"\n'
        f"{script}",
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

    # Retry mechanism
    retry_count = 3
    retry_delay = 5

    for attempt in range(retry_count):
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
        break
      except Exception:
        secho(out.stdout, err=True)
        secho(out.stderr, err=True)
        print(f"Failed to send job to LSF ({attempt+1}). Retry... ")
        time.sleep(retry_delay)
    else:
      # Retry attempts exhausted, raise an exception
      raise Exception("Failed to send jobs to LSF")

    return out


  @staticmethod
  def start_jobs_as_arrays(jobs: List[Job], batch_prefix: str, concurrency: int, max_array_size: int = 1000):
    """
    Jobs with identical bsub options are sent as 1 job array with a slot limit: `-J "name[1-n]%concurrency"`.
    Each array element picks its command from $LSB_JOBINDEX. Since the name starts with `batch_prefix`,
    `bkill -J "{batch_prefix}*"` and the WAIT job's dependency keep working.
    Note: the limit applies per array, so if runs need different LSF options (e.g. per input type), you may get more.
    """
    groups: Dict[Any, List[Job]] = {}
    for job in jobs:
      runner = cast(LsfRunner, job.runner)
      groups.setdefault(tuple(runner.bsub_options()), []).append(job)
    # LSF's default MAX_JOB_ARRAY_SIZE is 1000
    chunks = [g[i:i+max_array_size] for g in groups.values() for i in range(0, len(g), max_array_size)]
    if len(chunks) > 1:
      secho(f"WARNING: The runs need {len(chunks)} LSF job arrays (different LSF options, or >{max_array_size} runs). The concurrency limit ({concurrency}) applies to each array.", fg='yellow', err=True)
    for chunk in chunks:
      cases = []
      for index, job in enumerate(chunk, start=1):
        runner = cast(LsfRunner, job.runner)
        lines = [f"{index})"]
        if runner.output_dir:
          output_dir = runner.output_dir.resolve()
          lines.append(f'  mkdir -p "{output_dir}" && exec > "{output_dir}/log.lsf.txt" 2>&1')
        lines.extend([f"  {runner.command if runner.command else 'echo OK'}", "  ;;"])
        cases.append("\n".join(lines))
      script = "\n".join([
        # the click python package hates ascii locales, for good reasons
        # and we force a non-interactive matplotlib backend
        "export LC_ALL=en_US.utf8 LANG=en_US.utf8 MPLBACKEND=agg",
        'case "$LSB_JOBINDEX" in',
        *cases,
        "esac",
      ])
      runner = cast(LsfRunner, chunk[0].runner)
      array_name = f"{batch_prefix}_{runner.name.split('_', 1)[1]}"
      slot_limit = min(concurrency, len(chunk))
      # -o /dev/null: we redirect each run's output to its own log.lsf.txt, and without -o LSF sends emails.
      runner.bsub(script=script, name=f"{array_name}[1-{len(chunk)}]%{slot_limit}", log_file=Path('/dev/null'))


  @staticmethod
  def start_jobs_in_waves(jobs: List[Job], batch_prefix: str, concurrency: int):
    """
    Jobs are sent in waves of `concurrency` jobs, named "{batch_prefix}_W{k}_{random}".
    Each wave waits for the previous one to end. Note the "_" after the wave number: "W1_*" does not match "W10_...".
    """
    for wave_index, start in enumerate(range(0, len(jobs), concurrency)):
      flags = f'-w "ended({batch_prefix}_W{wave_index-1}_*)"' if wave_index > 0 else ''
      for job in jobs[start:start+concurrency]:
        runner = cast(LsfRunner, job.runner)
        random_str = runner.name.split('_', 1)[1]
        job.start(blocking=False, name=f"{batch_prefix}_W{wave_index}_{random_str}", flags=flags)


  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    # start asynchronously the jobs 
    options = dict_to_LsfOptions(job_options)
    batch_prefix = job_options['command_id'][:8]
    if options.concurrency > 0 and len(jobs) > options.concurrency:
      if options.concurrency_strategy == "waves":
        LsfRunner.start_jobs_in_waves(jobs, batch_prefix, options.concurrency)
      elif options.concurrency_strategy == "array":
        LsfRunner.start_jobs_as_arrays(jobs, batch_prefix, options.concurrency)
      else:
        raise ValueError(f"Unknown LSF concurrency_strategy: {options.concurrency_strategy}. Use 'array' or 'waves'.")
    else:
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
      batch_prefix = f"{job_options['command_id'][:8]}_"
      waiting_job.start(blocking=True, name=f'{batch_prefix}WAIT', flags=f'-w "ended({batch_prefix}*)"')

      # Our shared storage takes a while to sync when using LSF. It should be solved, and this sleep removed...
      if not all([j.id for j in jobs]): # if we can read the status from the database, no sync issue
        import time
        time.sleep(1) # seconds


  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
      # We could dot this to be sure we explicitely kill all jobs 
      #   command = " && ".join([f"bkill -J {job.name} 0" for job in jobs])
      # But we're only sending jobs as part of a single command...
      batch_prefix = job_options["command_id"][:8]
      bkill = f'bkill -J "{batch_prefix}*"'
      if job_options.get('bridge'):
        bkill = job_options.get('bridge', '').format(**job_options, bsub_command=bkill)
      secho(bkill, bold=True, err=True)
      out = subprocess.run(
          bkill,
          shell=True,
          encoding="utf-8",
          capture_output=True
      )
      print(out.stdout)
      print(out.stderr)
      # Not sure what the return code is supposed to be when killing multiple jobs
      # If LSF can't find the jobs, they are likely done already, but it returns 255, while we don't want to fail!
      #   out.check_returncode()
      # It's a better idea to check the logs for the status
      # It doens't cover all cases, but we don't need to be super careful
      being_terminated = "is being terminated" in out.stdout
      already_finished = "has already finished" in out.stdout
      job_not_found = "is not found" in out.stdout
      if not (being_terminated or job_not_found or already_finished): 
        raise ValueError(out.stdout)
