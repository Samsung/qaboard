from typing import List, Dict, Any

from .job import Job
from ..run import RunContext 


class BaseRunner():
  type: str

  def __init__(self, run_context : RunContext):
    self.run_context = run_context

  # Right now we don't call start directy, only start_jobs, so feel free to add parameters
  # if need be, we'll refactor all runners later. 
  def start(self, blocking=True):
    raise NotImplementedError

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
    raise NotImplementedError

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
    raise NotImplementedError
