# https://stackoverflow.com/a/33533514/5993501
from __future__ import annotations

import sys
import json
import time
import logging
from copy import deepcopy
from dataclasses import dataclass, field, asdict
from typing import Any


from ..run import RunContext 
from ..utils import ignored_signals
from ..api import url_to_dir, get_outputs, get_output, notify_qa_database

logger = logging.getLogger(__name__)

# TODO: We could make start_jobs belong to JobGroup as simply "start" 
#       It would be a bit simpler, but then we'd need new runners to implement two classes?

class Job:
    """Describes a task that will be sent to an async task queue"""
    def __init__(self, run_context: RunContext):
      # We reserve members that correspond to matching data in in the QA-Board database
      self.id: str | None = None
      self.qaboard_output: dict[str, Any] | None = None # as returned by the API 

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
          from ..ui import error
          error(f'The run failed. Its log is in QA-Board, and in {self.output_directory}')
        return failed
      else:
        return self.run_context.is_failed(verbose)



def output_finder(outputs: dict[Any, Any]):
  """
  Finds a job's run among those QA-Board knows (as the API returns them): by its id, else by its directory.
  The id comes first: a run that is done again gets a new directory (qaboard/attempts.py), that `qa batch` reserves,
  but its `qa run` may have used another, e.g. it runs with another version of qaboard, or LSF started the job twice.
  """
  by_id = {str(o['id']): o for o in outputs.values() if o.get('id') is not None}
  by_dir = {url_to_dir(o['output_dir_url']): o for o in outputs.values()}
  def find(job: Job) -> dict[str, Any] | None:
    output = by_id.get(str(job.id)) if job.id is not None else None
    return output or by_dir.get(job.run_context.output_dir)
  return find


@dataclass
class JobGroup:
  jobs: list[Job] = field(default_factory=list)
  job_options: dict[str, Any] | None = None
  # Batches can set options for the jobs started together, like their concurrency (Runner.group_options):
  # we start the jobs by groups with the same. Otherwise, e.g. when QA-Board redoes runs, all start with job_options.
  split_by_job_options: bool = True
  # once start() waited for them: the jobs that failed, for `qa batch`'s summary. None until then
  failed_jobs: list[Job] | None = field(default=None, init=False, repr=False)
  # those of them that said already why they failed, and where their log is
  explained_jobs: list[Job] = field(default_factory=list, init=False, repr=False)

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

  def groups(self) -> list[tuple[dict[str, Any], list[Job]]]:
    """The jobs, by groups with the same Runner.group_options, and the job options each group starts with."""
    assert self.job_options is not None
    if not self.split_by_job_options:
      return [(self.job_options, self.jobs)] if self.jobs else []
    groups: dict[str, tuple[dict[str, Any], list[Job]]] = {}
    for job in self.jobs:
      own_options = {k: v for k, v in job.run_context.job_options.items() if k in self.Runner.group_options}
      key = json.dumps(own_options, sort_keys=True, default=str)
      groups.setdefault(key, ({**self.job_options, **own_options}, []))[1].append(job)
    return list(groups.values())


  def start(self, blocking=True, qa_context: dict[str, Any] | None = None) -> bool:
    """
    Starts the jobs, and returns whether at least one failed.
    """
    if not self.jobs:
      return False
    groups = self.groups()
    logger.info("runner %s: starting %d runs in %d groups%s", self.Runner.type, len(self.jobs), len(groups), '' if blocking else ', not waiting for them')
    for options, jobs in groups:
      logger.debug("runner %s: %d runs with %s", self.Runner.type, len(jobs), options)
    started = time.monotonic()
    try:
      self.Runner.start_groups(groups, blocking)
    except (KeyboardInterrupt, SystemExit):
      # The runners stop the jobs when `qa batch` is stopped (SIGINT/SIGTERM), then exit
      if blocking:
        self.settle_pending_runs(qa_context)
      raise
    if not blocking:
      return True
    logger.info("runner %s: the runs ended in %.1fs", self.Runner.type, time.monotonic() - started)

    # Note: we used to always do as below, it's OK but makes many network requests
    # return any(job.is_failed(verbose=True) for job in self.jobs)

    # Note: We get all outputs in the batch, some not started in this command...
    finished_outputs = get_outputs(qa_context, ignore_errors=False)
    if not finished_outputs:
      is_offline = '--offline' in sys.argv or (qa_context or {}).get('offline')
      # local runs write on the local filesystem, no need to wait for a sync
      if not is_offline and self.Runner.type != 'local':
        sync_time = 30
        from ..ui import warning
        warning(f"QA-Board didn't say how the runs went: qa reads their folders instead, in {sync_time}s (the storage may take time to sync).")
        time.sleep(sync_time)
      # If we don't have jobs, either we were offline or something awful happened
      # (all of them: each failed run says where its log is)
      self.failed_jobs = [job for job in self.jobs if job.run_context.is_failed(verbose=True)]
      self.explained_jobs = list(self.failed_jobs)
      return bool(self.failed_jobs)

    # Here we add the matching outputs as job.qaboard_output
    find_output = output_finder(finished_outputs)

    failed: list[Job] = []
    # If runs are SIGKILL'ed, they never get a chance to update that they are done
    # it happens often when users use a lot of memory and some task queue manager gets angry
    jobs_with_pending_outputs = []
    for job in self.jobs:
      output = find_output(job)
      # we still fallback to the server-less check, in case the server was down during part of the runs...
      if not output:
        if job.run_context.is_failed(verbose=True):
          failed.append(job)
          self.explained_jobs.append(job)
      else:
        job.qaboard_output = output
        assert job.qaboard_output
        if job.qaboard_output["is_failed"]:
          failed.append(job)
        if job.qaboard_output['is_pending']:
          jobs_with_pending_outputs.append(job)

    for job in jobs_with_pending_outputs:
      if self.settle_pending_run(job, qa_context) and job not in failed:
        failed.append(job)
    self.failed_jobs = failed
    return bool(failed)

  @staticmethod
  def settle_pending_run(job: Job, qa_context: dict[str, Any] | None) -> bool:
    """Tells QA-Board that a run QA-Board shows as pending ended, failed unless it saved successful metrics. Returns whether it failed."""
    # where the run said it was, if we found it by its id. Runs that send their files to the server (qaboard/upload.py)
    # are in this computer's output/ folder: the server's folder isn't ours
    from ..config import uploads_files
    if job.qaboard_output and job.qaboard_output.get('output_dir_url') and not uploads_files:
      job.run_context.output_dir = url_to_dir(job.qaboard_output['output_dir_url'])
    if uploads_files:
      # metrics.json is written before the files are sent: the run may have been killed while it sent them
      from ..ui import error
      error(f"The run of {job.run_context.rel_input_path} never told QA-Board it ended, it may not have all its files: marked as failed.")
      job_is_failed = True
    else:
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

  def settle_pending_runs(self, qa_context: dict[str, Any] | None):
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
