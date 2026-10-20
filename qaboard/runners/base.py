from typing import List, Dict, Any, Tuple

from .job import Job
from ..run import RunContext 


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
