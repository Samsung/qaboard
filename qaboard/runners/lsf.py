"""
Utilities to communicate with SIRC's LSF cluster.

If you run into issues with LSF
- Search for IBM LSF's documentation online
- Be aware our IT overwrites LSF utilities (eg bsub...) with custom wrappers.
  Read them as they change environment variables.

Note:
- Windows compatibility is not guaranteed since we rely on shell features (heredocs) and 
"""
import os
import sys
import random
import shutil
import string
import subprocess
import time
from pathlib import Path
from dataclasses import dataclass, fields, replace, asdict
from typing import Optional, List, Dict, Any, Tuple, cast

from click import secho

from .base import BaseRunner
from .job import Job
from ..run import RunContext
from ..utils import getenvs



class LsfPriority:
  LOW    = 1000
  NORMAL = 2000
  HIGH   = 4000


@dataclass
class LsfOptions():
  # When not set, we don't pass the flag and bsub uses LSF's defaults:
  # $LSB_DEFAULTPROJECT / "default" for the project, $LSB_DEFAULTQUEUE / DEFAULT_QUEUE (lsb.params) for the queue.
  project: Optional[str] = None
  queue: Optional[str] = None
  # Default: LsfPriority.NORMAL, or LsfPriority.LOW for tuning runs
  priority: Optional[int] = None
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
  # Where we keep job arrays' bookkeeping. Set by `qa batch` to its batch directory.
  batch_dir: Optional[str] = None
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
  #   "ssh account@my-bridge-host 'qaboard-as-user {user} {bsub_command}'"
  # where qaboard-as-user is a site wrapper that runs the rest of its arguments as {user},
  # see website/docs/lsf-cluster-integration.mdx (`su {user} {bsub_command}` does NOT work: su runs it as a script file)
    

# We'll filter user-provided options, keeping only known ones
lsf_option_names = set(f.name for f in fields(LsfOptions))

def dict_to_LsfOptions(job_options):
  # "Easy" way to inherit documented defaults and get dot accessors...
  options = LsfOptions()
  filtered_options = {k:v for k,v in job_options.items() if k in lsf_option_names and v is not None}
  return replace(options, **filtered_options)


def redirect_to_log(output_dir: Path) -> str:
  """
  Shell line sending the job's output to <output_dir>/log.lsf.txt as it runs.
  LSF only writes its -o file when the job ends (unless LSB_STDOUT_DIRECT=Y), and we've seen it lose the output.
  We still ask LSF to write in the same file with -o: it appends its job report (exit reason, resource usage...) at the end.
  Note: `qa run` cleans its output directory, but keeps the file its output is redirected to.
  """
  output_dir = output_dir.resolve()
  return f'mkdir -p "{output_dir}" && exec > "{output_dir}/log.lsf.txt" 2>&1'


class LsfRunner(BaseRunner):
  """Start jobs using the LSF task management system."""
  type = "lsf"
  # Batches with their own get their own job arrays, or waves (see start_groups)
  group_options = ('concurrency', 'concurrency_strategy')

  def __init__(self, run_context : RunContext):
    self.run_context = run_context
    # aliases for  quick access
    self.output_dir: Optional[Path] = run_context.output_dir
    self.command = run_context.command

    self.options = dict_to_LsfOptions(run_context.job_options)
    # We've find it useful to dial back the priority if tuning jobs
    if self.options.priority is None:
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
    # log.txt is written by `qa run`. log.lsf.txt has all the job's output (e.g. from subprocesses, or crashes)
    # live, then LSF's job report. With -I (blocking), the output goes to the terminal, so we don't redirect it.
    lsf_log_file = (self.output_dir / "log.lsf.txt").resolve() if self.output_dir else None
    script = " ".join([
      # the click python package hates ascii locales, for good reasons
      "  LC_ALL=en_US.utf8 LANG=en_US.utf8" if self.command else '  ',
      # forces a non-interactive matplotlib backend
      "MPLBACKEND=agg" if self.command else '',
      self.command if self.command else 'echo OK',
    ])
    if self.output_dir and not blocking:
      script = f"  {redirect_to_log(self.output_dir)}\n{script}"
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
      f"-P '{self.options.project}'" if self.options.project else "",
      f"-q '{self.options.queue}'" if self.options.queue else "",
      f"-sp {self.options.priority}" if self.options.priority is not None else "",
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
        # -o appends to the file (-oo would overwrite)
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
    if not bridge_bsub_command and not shutil.which('bsub'):
      raise Exception("Can't send jobs to LSF: `bsub` was not found. Use another runner (e.g. --runner=local), or set QA_RUNNERS_LSF_BRIDGE.")

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


  @classmethod
  def submit_detached(cls, script: str, name: str, log_file: Path, job_options: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sends `script` as one LSF job (via the bridge if any), see BaseRunner.submit_detached.
    Its output goes to `log_file` as it runs, then LSF appends its job report (-o).
    """
    runner = cls.__new__(cls) # bsub only needs the options, not a run
    runner.options = dict_to_LsfOptions({'bridge': os.environ.get('QA_RUNNERS_LSF_BRIDGE', ''), **job_options})
    log_file = Path(log_file).resolve()
    out = runner.bsub(
      script="\n".join([
        f'mkdir -p "{log_file.parent}" && exec > "{log_file}" 2>&1',
        # the click python package hates ascii locales, and we force a non-interactive matplotlib backend
        "export LC_ALL=en_US.utf8 LANG=en_US.utf8 MPLBACKEND=agg",
        script,
      ]),
      name=name,
      log_file=log_file,
    )
    import re
    match = re.search(r'Job <(\d+)>', out.stdout or '')
    return {"lsf_job_id": match.group(1)} if match else {}


  @staticmethod
  def start_jobs_as_arrays(jobs: List[Job], batch_prefix: str, concurrency: int, max_array_size: int = 1000, batch_dir: Optional[str] = None):
    """
    Jobs with identical bsub options are sent as 1 job array with a slot limit: `-J "name[1-n]%concurrency"`.
    Each array element picks its command from $LSB_JOBINDEX. Since the name starts with `batch_prefix`,
    `bkill -J "{batch_prefix}*"` and `bwait` (see wait_jobs) keep working.
    Note: the limit applies per array, so if runs need different LSF options (e.g. per input type), you may get more.

    Array elements share the same -o file, but LSF replaces %I with the element's index. To have LSF write
    each element's job report in its run's log.lsf.txt, we use -o "{links_dir}/%I/log.lsf.txt",
    where {links_dir}/{index} is a symlink to the element's output directory.
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
      runner = cast(LsfRunner, chunk[0].runner)
      array_name = f"{batch_prefix}_{runner.name.split('_', 1)[1]}"
      output_dirs = [cast(LsfRunner, job.runner).output_dir for job in chunk]
      links_dir = None
      if all(output_dirs):
        links_root = Path(batch_dir) if batch_dir else Path(os.path.commonpath([str(d.resolve()) for d in output_dirs if d]))
        links_dir = (links_root / 'lsf' / array_name).resolve()
        try:
          links_dir.mkdir(parents=True, exist_ok=True)
          for index, output_dir in enumerate(output_dirs, start=1):
            assert output_dir
            (links_dir / str(index)).symlink_to(output_dir.resolve(), target_is_directory=True)
        except OSError as e:
          secho(f"WARNING: Could not create {links_dir} ({e}). LSF job reports won't be saved.", fg='yellow', err=True)
          links_dir = None

      cases = []
      for index, job in enumerate(chunk, start=1):
        runner = cast(LsfRunner, job.runner)
        lines = [f"{index})"]
        if runner.output_dir:
          lines.append(f"  {redirect_to_log(runner.output_dir)}")
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
      slot_limit = min(concurrency, len(chunk))
      # Without -o LSF sends emails.
      log_file = links_dir / '%I' / 'log.lsf.txt' if links_dir else Path('/dev/null')
      runner.bsub(script=script, name=f"{array_name}[1-{len(chunk)}]%{slot_limit}", log_file=log_file)


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
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True, waves_prefix: Optional[str] = None):
    """`waves_prefix` names the waves of jobs, by default the batch prefix."""
    # start asynchronously the jobs 
    options = dict_to_LsfOptions(job_options)
    batch_prefix = job_options['command_id'][:8]
    if options.concurrency > 0 and len(jobs) > options.concurrency:
      if options.concurrency_strategy == "waves":
        LsfRunner.start_jobs_in_waves(jobs, waves_prefix or batch_prefix, options.concurrency)
      elif options.concurrency_strategy == "array":
        LsfRunner.start_jobs_as_arrays(jobs, batch_prefix, options.concurrency, batch_dir=options.batch_dir)
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
        sys.exit(1)
      signal.signal(signal.SIGTERM, sigterm_handler)
      signal.signal(signal.SIGINT, sigterm_handler)


      LsfRunner.wait_jobs(batch_prefix, options)

      # Our shared storage takes a while to sync when using LSF. It should be solved, and this sleep removed...
      if not all([j.id for j in jobs]): # if we can read the status from the database, no sync issue
        import time
        time.sleep(1) # seconds


  @classmethod
  def start_groups(cls, groups: List[Tuple[Dict[str, Any], List[Job]]], blocking=True):
    """Sends all the groups, each with its concurrency, then waits for all of them: wait_jobs waits for all the batch's jobs."""
    for index, (job_options, jobs) in enumerate(groups):
      is_last = index == len(groups) - 1
      # Each group has its own waves: their dependencies use their names
      waves_prefix = f"{job_options['command_id'][:8]}_{index}" if index else None
      LsfRunner.start_jobs(jobs, job_options, blocking=blocking and is_last, waves_prefix=waves_prefix)


  @staticmethod
  def wait_jobs(batch_prefix: str, options: LsfOptions, retry_count=3, retry_delay=5):
    """
    Blocks until all the jobs named "{batch_prefix}_*" ended, using `bwait`.
    We used to submit a WAIT job depending on them with `bsub -I`, but interactive jobs need the execution host
    to connect back to the submission host, which fails e.g. from Docker containers. `bwait` only talks to mbatchd,
    which tells it when the condition is met: no polling, and no job taking a slot.
    Note: if `qa batch` itself runs inside an LSF job, bwait needs LSB_BWAIT_IN_JOBS=Y in lsf.conf.
    """
    bwait = f'bwait -w "ended({batch_prefix}_*)"'
    if options.bridge:
      bwait = options.bridge.format(**asdict(options), bsub_command=bwait)
    if 'QA_BATCH_VERBOSE' in os.environ:
      secho(bwait, dim=True, err=True)
    for attempt in range(retry_count):
      # bwait prints nothing unless something goes wrong, so we let its output go to the terminal
      out = subprocess.run(bwait, shell=True)
      if out.returncode == 0:
        return
      if attempt + 1 < retry_count:
        secho(f"Failed to wait for the LSF jobs ({attempt+1}). Retry... ", err=True)
        time.sleep(retry_delay)
    raise Exception(f"Failed to wait for the LSF jobs: `{bwait}` exited with {out.returncode}. They may still be running, see `bjobs -J \"{batch_prefix}_*\"`.")


  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
      # We could dot this to be sure we explicitly kill all jobs 
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
      # It doesn't cover all cases, but we don't need to be super careful
      being_terminated = "is being terminated" in out.stdout
      already_finished = "has already finished" in out.stdout
      job_not_found = "is not found" in out.stdout
      if not (being_terminated or job_not_found or already_finished):
        raise ValueError(out.stdout)


  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False):
    """bsub (or the bridge) works, the cluster answers, the queue exists. With test_job, a job runs and we see its results."""
    import shlex
    from ..checks import Check, OK, WARNING, ERROR
    from ..doctor import docs, run_command, tail
    page = docs('lsf-integration')
    options = dict_to_LsfOptions(job_options)
    if os.name == 'nt':
      yield Check("LSF", ERROR, "The lsf runner doesn't work on Windows.", fix=f"Run qa batch from a Linux machine that can submit LSF jobs, or use another runner: qa batch --runner local <batch>\nDocs: {page}")
      return

    def lsf(command: str) -> str:
      return options.bridge.format(**asdict(options), bsub_command=command) if options.bridge else command

    if options.bridge:
      bridge_fix = ("QA_RUNNERS_LSF_BRIDGE is a command with {bsub_command} where the LSF command goes, e.g.\n"
                    "  export QA_RUNNERS_LSF_BRIDGE='ssh lsf-host {bsub_command}'\n"
                    f"It can also use {', '.join('{' + n + '}' for n in sorted(lsf_option_names) if n != 'bridge')}.")
      try:
        lsf('bsub')
      except (KeyError, IndexError, ValueError) as e:
        yield Check("LSF bridge", ERROR, f"QA_RUNNERS_LSF_BRIDGE isn't a valid template ({type(e).__name__}: {e}): {options.bridge}", fix=bridge_fix)
        return
      if '{bsub_command}' not in options.bridge:
        yield Check("LSF bridge", ERROR, f"QA_RUNNERS_LSF_BRIDGE doesn't say where the LSF command goes: {options.bridge}", fix=bridge_fix)
        return
      yield Check("LSF bridge", OK, f"LSF commands go through QA_RUNNERS_LSF_BRIDGE: {options.bridge}")
    else:
      bsub = shutil.which('bsub')
      if not bsub:
        yield Check("LSF", ERROR, "`bsub` isn't on the PATH: LSF isn't set up in this shell.",
                    fix=("Load LSF's environment, e.g.: source <LSF_TOP>/conf/profile.lsf   (your cluster's admins know where it is),\n"
                         "or run qa from a machine that can submit LSF jobs.\n"
                         f"To run on this machine instead: qa batch --runner local <batch>\nDocs: {page}"))
        return
      yield Check("LSF", OK, f"bsub: {bsub}")
      if not shutil.which('bwait'):
        yield Check("LSF bwait", WARNING, "`bwait` isn't on the PATH: `qa batch` waits for its runs with it (LSF 10.1 or later).",
                    fix=f"Use qa batch --no-wait, and follow the runs in QA-Board, or ask your LSF admins about bwait.\nDocs: {page}#waiting-for-the-runs")

    # The cluster answers, and the queue exists
    queues_command = lsf(f"bqueues -w {shlex.quote(options.queue)}" if options.queue else "bqueues -w")
    returncode, output = run_command(queues_command, timeout=20)
    if returncode is None:
      yield Check("LSF queue", ERROR, f"`{queues_command}` didn't answer in 20s: LSF's master may be unreachable or overloaded.",
                  fix="Try `bqueues` yourself. If it hangs, tell your LSF admins.")
      return
    queue_snippet = "runners:\n  lsf:\n    queue: <queue>"
    if returncode != 0:
      if options.queue and 'no such queue' in output.lower():
        yield Check("LSF queue", ERROR, f"There is no LSF queue named {options.queue!r}.",
                    fix=f"List the queues with: bqueues\nThen set yours in qaboard.yaml:\n{queue_snippet}\nor for one batch: qa batch --lsf-queue <queue> <batch>\nDocs: {page}")
      else:
        yield Check("LSF queue", ERROR, f"`{queues_command}` failed (exit code {returncode}):\n{tail(output)}",
                    fix="LSF may be down, or your account not set up for it: tell your LSF admins, with this error.")
      return
    if options.queue:
      line = next((l for l in output.splitlines() if l.split()[:1] == [options.queue]), '')
      status = line.split()[2] if len(line.split()) > 2 else ''
      if status.startswith('Closed'):
        yield Check("LSF queue", ERROR, f"The LSF queue {options.queue} is closed ({status}): it doesn't accept jobs.", fix=f"Use another queue (bqueues lists them), or ask your LSF admins.\n{queue_snippet}")
      elif 'Inact' in status:
        yield Check("LSF queue", WARNING, f"The LSF queue {options.queue} is inactive ({status}): jobs wait until it's active again.", fix="Use another queue (bqueues lists them), or ask your LSF admins.")
      else:
        yield Check("LSF queue", OK, f"{options.queue}{f' ({status})' if status else ''}")
    else:
      yield Check("LSF queue", OK, f"LSF answers. Jobs go to the cluster's default queue: to choose one, in qaboard.yaml:\n{queue_snippet}")

    # LSF knows us
    jobs_command = lsf("bjobs -w")
    returncode, output = run_command(jobs_command, timeout=20)
    if returncode == 0 or 'no unfinished job' in output.lower():
      jobs = [l for l in output.splitlines() if l.strip() and not l.startswith('JOBID') and 'No unfinished job' not in l]
      yield Check("LSF jobs", OK, f"bjobs answers: {len(jobs)} unfinished job{'s' if len(jobs) != 1 else ''} of yours")
    else:
      yield Check("LSF jobs", ERROR, f"`{jobs_command}` failed{' (timed out)' if returncode is None else f' (exit code {returncode})'}:\n{tail(output)}",
                  fix="Your account may not be set up for LSF: tell your LSF admins, with this error.")
      return

    if test_job:
      yield from cls.doctor_test_job(job_options, lsf, use_bwait=bool(options.bridge or shutil.which('bwait')))


  @classmethod
  def doctor_test_job(cls, job_options: Dict[str, Any], lsf, use_bwait: bool = True, timeout: float = 300):
    """Sends a job that says where it runs, as who, if it sees `qa` and the batch's folder, and waits for it (`timeout` seconds at most)."""
    from ..checks import Check, OK, WARNING, ERROR
    from ..doctor import tail, make_test_dir, remove_test_dir
    name = "LSF test job"
    job_name = f"{(job_options.get('command_id') or 'qadoctor')[:8]}_doctor"
    submitted = ended = False
    try:
      test_dir, existing = make_test_dir(job_options)
    except OSError as e:
      yield Check(name, ERROR, f"Can't create the test job's folder: {e}", fix="Fix the storage first (see above).")
      return
    result = test_dir / 'result.txt'
    try:
      # start() puts environment variables before the command: it can't start with a { group }
      script = f'echo "user: $(id -un)" > "{result}"; echo "host: $(hostname)" >> "{result}"; echo "qa: $(command -v qa || echo not found)" >> "{result}"'
      run_context = RunContext(type='default', input_path=Path(), database=Path(), platform='linux', configurations=[],
                               job_options=job_options, output_dir=test_dir, command=script)
      start = time.time()
      try:
        cls(run_context).start(blocking=False, name=job_name)
      except Exception as e:
        yield Check(name, ERROR, f"Couldn't submit a test job: {e}", fix="Run with QA_BATCH_VERBOSE=1 to see the bsub command, and try it yourself.")
        return
      submitted = True
      ended = cls.doctor_wait(job_name, lsf, use_bwait, timeout)
      elapsed = time.time() - start
      if not ended:
        yield Check(name, WARNING, f"The test job didn't end in {timeout / 60:.0f} minutes: it may be waiting for a slot. qa doctor stopped it.",
                    fix=f"See why jobs wait: bjobs -l -u $USER   (or bhist -l -J {job_name})\nThen run qa doctor --test-job again.")
        return
      if not result.exists():
        log = test_dir / 'log.lsf.txt'
        logs = f"\nIts log ({log}):\n{tail(log.read_text(errors='replace'), 10)}" if log.exists() else ''
        yield Check(name, ERROR, f"The test job ended, but {result} isn't there: the job failed, or the LSF hosts don't see {test_dir.parent} at the same path.{logs}",
                    fix=f"See what happened: bhist -l -J {job_name}\nThe LSF hosts must mount the storage at the same path as this machine: ask your LSF admins.")
        return
      found = dict(line.split(': ', 1) for line in result.read_text(errors='replace').splitlines() if ': ' in line)
      where = f"on {found.get('host', '?')} as {found.get('user', '?')}, in {elapsed:.0f}s"
      if found.get('qa', 'not found') == 'not found':
        yield Check(name, ERROR, f"A test job ran {where}, but `qa` isn't on its PATH: the runs would fail.",
                    fix="LSF jobs get the environment you submit them from: install qaboard where the LSF hosts see it\n(e.g. a virtual environment on a shared drive), and run qa batch from that environment.")
        return
      yield Check(name, OK, f"A test job ran {where}, wrote in {test_dir.parent}, and found {found['qa']}")
    finally:
      # e.g. it was still pending, or Ctrl-C: we don't leave it behind
      if submitted and not ended:
        subprocess.run(lsf(f'bkill -J "{job_name}"'), shell=True, capture_output=True)
      remove_test_dir(test_dir, existing)


  @staticmethod
  def doctor_wait(job_name: str, lsf, use_bwait: bool, timeout: float) -> bool:
    """Whether a job ended within `timeout` seconds: we wait with bwait, else we poll bjobs."""
    from ..doctor import run_command
    if use_bwait:
      # bwait's timeout is in minutes
      try:
        out = subprocess.run(lsf(f'bwait -w "ended({job_name})" -t {max(1, round(timeout / 60))}'), shell=True,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', timeout=timeout + 60)
        if out.returncode == 0:
          return True
      except subprocess.TimeoutExpired:
        pass
      # bwait fails when it times out, but also e.g. inside LSF jobs without LSB_BWAIT_IN_JOBS: bjobs says
      deadline = time.time()
    else:
      deadline = time.time() + timeout
    while True:
      returncode, output = run_command(lsf(f'bjobs -a -noheader -o "stat" -J "{job_name}"'), timeout=20)
      status = output.strip().split()[0] if output.strip() else ''
      if status in ('DONE', 'EXIT') or 'not found' in output:
        return True
      if time.time() >= deadline:
        return False
      time.sleep(5)
