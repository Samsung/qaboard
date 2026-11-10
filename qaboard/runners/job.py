# https://stackoverflow.com/a/33533514/5993501
from __future__ import annotations

import sys
import json
import time
from copy import deepcopy
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any, Tuple

import click

from ..run import RunContext 
from ..utils import ignored_signals
from ..api import url_to_dir, get_outputs, get_output, notify_qa_database

# TODO: We could make start_jobs belong to JobGroup as simply "start" 
#       It would be a bit simpler, but then we'd need new runners to implement two classes?

class Job():
    """Describes a task that will be sent to an async task queue"""
    def __init__(self, run_context: RunContext):
      # We reserve members that correspond to matching data in in the QA-Board database
      self.id: Optional[str] = None
      self.qaboard_output: Optional[Dict[str, Any]] = None # as returned by the API 

      self.run_context = deepcopy(run_context)
      from . import runners
      Runner = runners[run_context.job_options['type']]
      self.runner = Runner(self.run_context)

    def asdict(self):
      return asdict(self)

    def start(self, blocking=True, **kwargs):
        return self.runner.start(blocking, **kwargs)

    def is_failed(self, verbose=False):
      if self.id:
        output_db = get_output(self.id)
        failed = not output_db or output_db["is_failed"]
        if failed and verbose:
          click.secho(f'ERROR: Failed run! More info in QA-Board or at: {self.output_directory}', fg='red', err=True)
        return failed
      else:
        return self.run_context.is_failed(verbose)



def output_finder(outputs: Dict[Any, Any]):
  """
  Finds a job's run among those QA-Board knows (as the API returns them): by its id, else by its directory.
  The id comes first: a run that is done again gets a new directory (qaboard/attempts.py), that `qa batch` reserves,
  but its `qa run` may have used another, e.g. it runs with another version of qaboard, or LSF started the job twice.
  """
  by_id = {str(o['id']): o for o in outputs.values() if o.get('id') is not None}
  by_dir = {url_to_dir(o['output_dir_url']): o for o in outputs.values()}
  def find(job: 'Job') -> Optional[Dict[str, Any]]:
    output = by_id.get(str(job.id)) if job.id is not None else None
    return output or by_dir.get(job.run_context.output_dir)
  return find


@dataclass
class JobGroup():
  jobs: List[Job] = field(default_factory=list)
  job_options: Optional[Dict[str, Any]] = None
  # Batches can set options for the jobs started together, like their concurrency (Runner.group_options):
  # we start the jobs by groups with the same. Otherwise, e.g. when QA-Board redoes runs, all start with job_options.
  split_by_job_options: bool = True

  # https://docs.python.org/3/library/dataclasses.html
  def __post_init__(self):
    from . import runners
    self.Runner = runners[self.job_options['type']]

  def __len__(self):
    return len(self.jobs)

  def __iter__(self):
    return iter(self.jobs)

  def __getitem__(self, key):
    return self.jobs[key]

  def append(self, job : Job):
    self.jobs.append(job)

  def groups(self) -> List[Tuple[Dict[str, Any], List[Job]]]:
    """The jobs, by groups with the same Runner.group_options, and the job options each group starts with."""
    assert self.job_options is not None
    if not self.split_by_job_options:
      return [(self.job_options, self.jobs)] if self.jobs else []
    groups: Dict[str, Tuple[Dict[str, Any], List[Job]]] = {}
    for job in self.jobs:
      own_options = {k: v for k, v in job.run_context.job_options.items() if k in self.Runner.group_options}
      key = json.dumps(own_options, sort_keys=True, default=str)
      groups.setdefault(key, ({**self.job_options, **own_options}, []))[1].append(job)
    return list(groups.values())


  def start(self, blocking=True, qa_context: Optional[Dict[str, Any]] = None) -> bool:
    """
    Starts the jobs, and returns whether at least one failed.
    """
    if not self.jobs:
      return False
    try:
      self.Runner.start_groups(self.groups(), blocking)
    except (KeyboardInterrupt, SystemExit):
      # The runners stop the jobs when `qa batch` is stopped (SIGINT/SIGTERM), then exit
      if blocking:
        self.settle_pending_runs(qa_context)
      raise
    if not blocking:
      return True

    # Note: we used to always do as below, it's OK but makes many network requests
    # return any(job.is_failed(verbose=True) for job in self.jobs)

    # Note: We get all outputs in the batch, some not started in this command...
    finished_outputs = get_outputs(qa_context, ignore_errors=False)
    if not finished_outputs:
      is_offline = '--offline' in sys.argv or (qa_context or {}).get('offline')
      # local runs write on the local filesystem, no need to wait for a sync
      if not is_offline and self.Runner.type != 'local':
        sync_time = 30
        click.secho(f'[WARNING] Since we could not access the status of the runs via the QA-Board server', fg='yellow', bold=True, err=True)
        click.secho(f'          We will fall back to looking at output folders directly.', fg='yellow', err=True)
        click.secho(f'          Due to filesystem sync it might not always work well, so we sleeping for {sync_time}s.', fg='yellow', err=True)
        time.sleep(sync_time)
      # If we don't have jobs, either we were offline or something awful happened
      return any(job.run_context.is_failed(verbose=True) for job in self.jobs)

    # Here we add the matching outputs as job.qaboard_output
    find_output = output_finder(finished_outputs)

    is_failed = False
    # If runs are SIGKILL'ed, they never get a chance to update that they are done
    # it happens often when users use a lot of memory and some task queue manager gets angry 
    jobs_with_pending_outputs = []
    for job in self.jobs:
      output = find_output(job)
      # we still fallback to the server-less check, in case the server was down during part of the runs...
      if not output:
        is_failed = is_failed or job.run_context.is_failed(verbose=True)
      else:
        job.qaboard_output = output
        assert job.qaboard_output
        is_failed = is_failed or job.qaboard_output["is_failed"]
        if job.qaboard_output['is_pending']:
          jobs_with_pending_outputs.append(job)

    for job in jobs_with_pending_outputs:
      is_failed = self.settle_pending_run(job, qa_context) or is_failed
    return is_failed

  @staticmethod
  def settle_pending_run(job: Job, qa_context: Optional[Dict[str, Any]]) -> bool:
    """Tells QA-Board that a run QA-Board shows as pending ended, failed unless it saved successful metrics. Returns whether it failed."""
    # where the run said it was, if we found it by its id
    if job.qaboard_output and job.qaboard_output.get('output_dir_url'):
      job.run_context.output_dir = url_to_dir(job.qaboard_output['output_dir_url'])
    job_is_failed = job.run_context.is_failed(verbose=True)
    if not job_is_failed:
      print("[INFO] Job status was 'pending':", job.run_context, job.qaboard_output)
    notify_qa_database(**{
      **(qa_context if qa_context else {}),
      **job.run_context.obj, # for now we don't want to worry about backward compatibility, and input_path being abs vs relative...
      "is_pending": False,
      "is_failed": job_is_failed,
    })
    return job_is_failed

  def settle_pending_runs(self, qa_context: Optional[Dict[str, Any]]):
    """
    When `qa batch` is stopped, the runs it stopped that QA-Board still shows as pending are marked as failed.
    Their `qa run` usually says so, but not if it was killed with SIGKILL, or never started.
    """
    with ignored_signals():
      try:
        outputs = get_outputs(qa_context, ignore_errors=True)
      except Exception:
        return
      find_output = output_finder(outputs)
      for job in self.jobs:
        output = find_output(job)
        if output and output['is_pending']:
          job.qaboard_output = output
          self.settle_pending_run(job, qa_context)

  # Currently called onlt by the backend when it tries to stop a `qa batch` command
  # Sadly it only knows about the command_id, not jobs....
  # TODO: make it stop_command to make usage clearer..
  def stop(self):
    """Returns what the runner's stop_jobs returns, e.g. how many Kubernetes Jobs were deleted (None if it doesn't know)"""
    return self.Runner.stop_jobs(self.jobs, self.job_options)
