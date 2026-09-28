"""
Run `qa run` commands on a pool of long-lived Dask workers.

Why? With the LSF runner each run is 1 LSF job, and pays the scheduling/allocation overhead.
Here we ask LSF for a few worker jobs, and each worker executes many runs, with a bounded concurrency.

Two modes:
- By default, `qa batch` starts a Dask scheduler in-process, and uses dask-jobqueue to bsub
  worker jobs named "{command_id[:8]}_dask". They are stopped when the batch ends.
  Since the scheduler lives in the `qa batch` process, --no-wait is not supported.
- If `scheduler_address` is set, we connect to an existing Dask cluster (started by you,
  e.g. with `dask scheduler` + `dask worker` sent via bsub, or dask-jobqueue).

Setup: `pip install qaboard[dask]`. Workers need the same python environment (shared filesystem).

qaboard.yaml:
  runners:
    default: dask
    dask:
      concurrency: 20                # max runs in flight for a `qa batch`
      # scheduler_address: tcp://my-host:8786
      cluster:                       # kwargs for dask_jobqueue.LSFCluster, override the defaults below
        cores: 4                     # runs per worker job (each run is a thread in the worker)
        memory: 32GB                 # per worker job, so it should cover `cores` runs
        # walltime: "24:00"
        # interface: ib0
"""
import os
import sys
import math
import asyncio
import time
import signal
import threading
import subprocess
from pathlib import Path
from dataclasses import dataclass, field, replace, fields
from typing import Optional, List, Dict, Any, Set

from click import secho

from .base import BaseRunner
from .job import Job
from ..run import RunContext


@dataclass
class DaskOptions():
  # Max number of runs from a single `qa batch` running at the same time
  concurrency: int = 10
  # Connect to an existing cluster. If not set, we start worker jobs on LSF via dask-jobqueue
  scheduler_address: Optional[str] = None
  # kwargs for dask_jobqueue.LSFCluster
  cluster: Dict[str, Any] = field(default_factory=dict)
  # defaults for the LSF worker jobs, taken from `runners.lsf`: queue, project, resources, max_memory, options
  lsf: Dict[str, Any] = field(default_factory=dict)
  cwd: Optional[str] = None
  # If all workers are gone for that long (e.g. killed by LSF), we give up. Before the first worker starts we wait forever, like LSF.
  no_worker_timeout: float = 600 # seconds

dask_option_names = set(f.name for f in fields(DaskOptions))

def dict_to_DaskOptions(job_options: Dict[str, Any]) -> DaskOptions:
  filtered_options = {k: v for k, v in job_options.items() if k in dask_option_names and v is not None}
  return replace(DaskOptions(), **filtered_options)


# The client's environment is forwarded to the runs, minus what is specific to the client's host or LSF job
excluded_env = {'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', 'TMPDIR', 'TMP', 'TEMP', 'CUDA_VISIBLE_DEVICES', '_'}
excluded_env_prefixes = ('LSB_', 'LSF_', 'DASK_')
def forwarded_env() -> Dict[str, str]:
  return {k: v for k, v in os.environ.items() if k not in excluded_env and not k.startswith(excluded_env_prefixes)}


###
### What runs on the workers.
###
# command_id -> running processes. Used to kill runs, since Dask can't cancel a task that already started.
_processes: Dict[str, Set[subprocess.Popen]] = {}
_processes_lock = threading.Lock()


def run_command(command: str, cwd: Optional[str], env: Dict[str, str], log_path: Optional[str], command_id: str) -> int:
  """Executed on a worker thread. Returns the command's return code."""
  if log_path:
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
  with open(log_path if log_path else os.devnull, 'w') as log:
    process = subprocess.Popen(
      command,
      shell=True,
      cwd=cwd,
      env={**os.environ, **env},
      stdout=log,
      stderr=subprocess.STDOUT,
    )
    with _processes_lock:
      _processes.setdefault(command_id, set()).add(process)
    try:
      return process.wait()
    finally:
      with _processes_lock:
        _processes[command_id].discard(process)
        if not _processes[command_id]:
          del _processes[command_id]


def kill_command(command_id: str) -> int:
  """Executed on each worker via client.run: kills the process trees of the runs from a given `qa batch`."""
  import psutil # type: ignore
  with _processes_lock:
    processes = list(_processes.get(command_id, []))
  for process in processes:
    try:
      parent = psutil.Process(process.pid)
      tree = [*parent.children(recursive=True), parent]
    except psutil.NoSuchProcess:
      continue
    for p in tree:
      try:
        p.terminate()
      except psutil.NoSuchProcess:
        pass
    _, alive = psutil.wait_procs(tree, timeout=10)
    for p in alive:
      try:
        p.kill()
      except psutil.NoSuchProcess:
        pass
  return len(processes)


# How often `qa batch` checks whether it was stopped, or if workers are gone
poll_interval = 5 # seconds


def stop_event_name(command_id: str) -> str:
  return f"qaboard-stop-{command_id}"


###
### What runs in `qa batch`
###
def make_lsf_cluster(options: DaskOptions, batch_prefix: str, nb_runs: int):
  from dask_jobqueue import LSFCluster # type: ignore
  lsf = options.lsf
  job_extra_directives = []
  if lsf.get('resources'):
    job_extra_directives.append(f'-R "{lsf["resources"]}"')
  if lsf.get('options'):
    job_extra_directives.append(lsf['options'])
  log_directory = Path.home() / '.qaboard' / 'dask-logs'
  cluster_kwargs = {
    "job_name": f"{batch_prefix}_dask", # so that `bkill -J "{batch_prefix}*"` stops the workers
    "queue": lsf.get('queue'),
    "project": lsf.get('project'),
    "cores": 1,
    "processes": 1,
    "memory": f"{lsf['max_memory']}MB" if lsf.get('max_memory') else "4GB",
    # Runs may be long, by default we let the LSF queue decide the time limit
    "job_directives_skip": ["#BSUB -W"],
    "job_extra_directives": job_extra_directives,
    # Otherwise LSF sends emails with the worker logs...
    "log_directory": str(log_directory),
    **options.cluster,
  }
  if 'walltime' in options.cluster:
    cluster_kwargs['job_directives_skip'] = options.cluster.get('job_directives_skip', [])
  Path(cluster_kwargs['log_directory']).mkdir(parents=True, exist_ok=True)
  cluster = LSFCluster(**{k: v for k, v in cluster_kwargs.items() if v is not None})

  runs_per_worker = max(1, cluster_kwargs['cores'] // cluster_kwargs['processes'])
  nb_worker_jobs = math.ceil(min(nb_runs, options.concurrency) / runs_per_worker)
  if 'QA_BATCH_VERBOSE' in os.environ:
    secho(cluster.job_script(), dim=True, err=True)
  secho(f"Starting {nb_worker_jobs} dask worker(s) on LSF ({runs_per_worker} runs each). Logs: {cluster_kwargs['log_directory']}", err=True)
  cluster.scale(jobs=nb_worker_jobs)
  return cluster


class DaskRunner(BaseRunner):
  """Execute runs on Dask workers, by default started as LSF jobs."""
  type = "dask"

  def __init__(self, run_context: RunContext):
    self.run_context = run_context

  def start(self, blocking=True):
    raise NotImplementedError("Use start_jobs")

  @staticmethod
  def submit(client, job: Job, index: int, job_options: Dict[str, Any], env: Dict[str, str]):
    command_id = job_options['command_id']
    output_dir = job.run_context.output_dir
    log_path = str((output_dir / "log.dask.txt").resolve()) if output_dir else None
    cwd = job.run_context.job_options.get('cwd', job_options.get('cwd', os.getcwd()))
    return client.submit(
      run_command,
      job.run_context.command,
      str(cwd),
      env,
      log_path,
      command_id,
      key=f"qaboard-{command_id}-{index}",
      pure=False,
    )

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    from distributed import Client, Event, fire_and_forget, wait # type: ignore
    options = dict_to_DaskOptions(job_options)
    command_id = job_options['command_id']
    batch_prefix = command_id[:8]
    env = forwarded_env()

    cluster = None
    if options.scheduler_address:
      client = Client(options.scheduler_address)
    else:
      if not blocking:
        secho("WARNING: --no-wait is not supported by the dask runner without a `scheduler_address`: the workers live as long as `qa batch`.", fg='yellow', err=True)
      cluster = make_lsf_cluster(options, batch_prefix, nb_runs=len(jobs))
      client = Client(cluster)

    try:
      if not blocking and options.scheduler_address:
        secho("WARNING: with --no-wait, all runs are sent at once, and `concurrency` is not enforced.", fg='yellow', err=True)
        fire_and_forget([DaskRunner.submit(client, job, index, job_options, env) for index, job in enumerate(jobs)])
        return

      in_flight: Dict[Any, Job] = {}
      def abort(_signo=None, _stackframe=None):
        print('Aborted.')
        client.cancel(list(in_flight))
        client.run(kill_command, command_id)
        # sys.exit: the finally clause below closes the cluster (and bkills the workers)
        sys.exit(1)
      signal.signal(signal.SIGTERM, abort)
      signal.signal(signal.SIGINT, abort)

      # Lets `qa` in the backend stop the batch
      stop_event = Event(stop_event_name(command_id), client=client)

      # Sliding window of `concurrency` runs
      pending = list(enumerate(jobs))
      pending.reverse()
      concurrency = options.concurrency if options.concurrency > 0 else len(jobs)
      nb_failed = 0
      seen_workers, no_worker_since = False, None
      while pending or in_flight:
        if stop_event.is_set():
          secho("The batch was stopped.", fg='red', err=True)
          abort()
        while pending and len(in_flight) < concurrency:
          index, job = pending.pop()
          in_flight[DaskRunner.submit(client, job, index, job_options, env)] = job
        try:
          done, _ = wait(list(in_flight), timeout=poll_interval, return_when="FIRST_COMPLETED")
        except (TimeoutError, asyncio.TimeoutError): # unlike concurrent.futures.wait, it raises. Different classes before python 3.11
          done = set()
        for future in done:
          job = in_flight.pop(future)
          try:
            return_code = future.result()
            if return_code != 0:
              nb_failed += 1
              secho(f"Failed run (return code {return_code}): {job.run_context.output_dir}", fg='red', err=True)
          except Exception as e: # e.g. KilledWorker, if the worker died several times while running it
            nb_failed += 1
            secho(f"Failed run ({type(e).__name__}: {e}): {job.run_context.output_dir}", fg='red', err=True)
        if client.scheduler_info()['workers']:
          seen_workers, no_worker_since = True, None
        elif seen_workers:
          no_worker_since = no_worker_since or time.time()
          if time.time() - no_worker_since > options.no_worker_timeout:
            secho(f"ERROR: No dask worker for {options.no_worker_timeout}s, giving up.", fg='red', err=True)
            abort()
      if 'QA_BATCH_VERBOSE' in os.environ:
        secho(f"{len(jobs)} runs done, {nb_failed} failed.", err=True)
    finally:
      client.close()
      if cluster is not None:
        cluster.close()

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    options = dict_to_DaskOptions(job_options)
    command_id = job_options['command_id']
    if options.scheduler_address:
      from distributed import Client, Event # type: ignore
      with Client(options.scheduler_address, timeout=30) as client:
        # The `qa batch` process stops sending runs...
        Event(stop_event_name(command_id), client=client).set()
        # ...and we kill those that are running
        client.run(kill_command, command_id)
    else:
      # The workers are LSF jobs with the batch prefix: killing them makes `qa batch` see failures.
      from .lsf import LsfRunner
      lsf_options = {**job_options, 'bridge': job_options.get('bridge') or os.environ.get('QA_RUNNERS_LSF_BRIDGE', '')}
      LsfRunner.stop_jobs(jobs, lsf_options)
