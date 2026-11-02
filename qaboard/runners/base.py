from pathlib import Path
from typing import List, Dict, Any, Tuple, Iterable

from .job import Job
from ..run import RunContext
from ..checks import Check


class BaseRunner():
  type: str
  # Job options that apply to all the jobs started together, e.g. how many run at the same time.
  # Batches can set their own: JobGroup starts the jobs by groups with the same values.
  group_options: Tuple[str, ...] = ()

  def __init__(self, run_context : RunContext):
    self.run_context = run_context

  # Right now we don't call start directly, only start_jobs, so feel free to add parameters
  # if need be, we'll refactor all runners later.
  def start(self, blocking=True):
    raise NotImplementedError

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    raise NotImplementedError

  @classmethod
  def start_groups(cls, groups: List[Tuple[Dict[str, Any], List[Job]]], blocking=True):
    """Starts groups of jobs, each with its job options. By default, one group after the other."""
    for job_options, jobs in groups:
      cls.start_jobs(jobs, job_options, blocking)

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    raise NotImplementedError

  @classmethod
  def submit_detached(cls, script: str, name: str, log_file: Path, job_options: Dict[str, Any]) -> Dict[str, Any]:
    """
    Starts `script` (bash) as a single job that outlives the caller, and returns right away.
    Used for what must keep running after `qa` or the server returns: the dask --no-wait driver,
    batches started from the web app...
    - `name` identifies the job. It starts with job_options['command_id'][:8], so stop_jobs() stops it too.
    - The job's output (stdout and stderr) goes to `log_file`, live.
    - job_options are the runner's usual job options (queue, namespace, image, run_as...).
    Returns what identifies the job, e.g. {"lsf_job_id": "1234"} or {"kubernetes_job": "qa-abcdefgh-driver", "namespace": "..."}.
    Raises if the job could not be submitted, with a message that says why and how to fix it.
    """
    raise NotImplementedError(f"The {cls.type} runner can't start detached jobs.")

  @classmethod
  def doctor(cls, job_options: Dict[str, Any], test_job: bool = False) -> Iterable[Check]:
    """
    Checks that this runner can start runs with these job options (from qaboard.yaml and the CLI), for `qa doctor`.
    Yields Checks, from the most basic (is the tool installed, can we authenticate) to the most specific.
    Each failed check says how to fix it: a command, a qaboard.yaml snippet, or what to ask the admins.
    With `test_job`, also starts a small job to check it really runs (where, as who, what it can access).
    Checks must not raise: an unexpected exception becomes an ERROR check.
    """
    return []
