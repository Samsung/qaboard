from typing import List, Dict, Any

from .base import BaseRunner
from .job import Job
from ..run import RunContext 

class CeleryRunner(BaseRunner):
  type = "celery"

  def start(self, blocking=True, **kwargs):
    raise NotImplementedError

  @staticmethod
  def start_jobs(jobs: List[Job], job_options: Dict[str, Any], blocking=True):
      raise NotImplementedError

  @staticmethod
  def stop_jobs(jobs: List[Job], job_options: Dict[str, Any]):
      raise NotImplementedError
