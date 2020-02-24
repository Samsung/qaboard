from typing import Optional, List, Dict, Any

from .job import Job
from ..run import RunContext 


class CeleryRunner():
  type = "celery"

  def __init__(self, run_context : RunContext):
    raise NotImplementedError

  def start(self, blocking=True, **kwargs):
    raise NotImplementedError

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Optional[Dict[str, Any]]= None, blocking=True):
      raise NotImplementedError

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Optional[Dict[str, Any]] = None):
      raise NotImplementedError
