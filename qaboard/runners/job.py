# https://stackoverflow.com/a/33533514/5993501
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any, Callable

from ..run import RunContext 
from ..conventions import url_to_dir

# TODO: We could make start_jobs belong to JobGroup as simply "start" 
#       It would be a bit simpler, but then we'd need new runners to implement two classes?

class Job():
    """Describes a task that will be sent to an async task queue"""
    def __init__(self, run_context: RunContext):
        self.id = None # ID in the QA-Board database
        self.run_context = run_context
        from . import runners
        for Runner in runners.values():
            if run_context.job_options['type'] == Runner.type:
                self.runner = Runner(run_context)

    def asdict(self):
      return asdict(self)

    def start(self, blocking=True, **kwargs):
        self.runner.start(blocking, **kwargs)

    def is_failed(self, verbose=False):
      if self.id:
        output_db = get_output(self.id)
        failed = not output_db or output_db["is_failed"]
        if failed and verbose:
          click.secho(f'ERROR: Failed run! More info in QA-Board or at: {self.output_directory}', fg='red', err=True)
        return failed
      else:
        return self.run_context.is_failed(verbose)



@dataclass
class JobGroup():
  jobs: List[Job] = field(default_factory=list)
  job_options: Optional[Dict[str, Any]] = None

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


  def start(self, blocking=True, get_qaboard_outputs: Optional[Callable[[], Dict[int, Any]]] = None) -> bool:
    """
    Starts the jobs, and returns whether at least one failed.
    """
    if not self.jobs:
      return False
    self.Runner.start_jobs(self.jobs, self.job_options, blocking)

    # Note: we used to always do as below, it's OK but makes many network requests
    # return any(job.is_failed(verbose=True) for job in self.jobs)

    finished_outputs = get_qaboard_outputs() if get_qaboard_outputs else []
    if not finished_outputs:
      # If we don't have jobs, either we were offline or something aweful happenned
      return any(job.run_context.is_failed(verbose=True) for job in self.jobs)

    # We get a whole batch of results, with possibly outputs not started in this batch
    jobs_output_dirs = set([j.run_context.output_dir for j in self.jobs])
    matching_finished_outputs = [o for o in finished_outputs.values() if url_to_dir(o['output_dir_url']) in jobs_output_dirs]
    assert len(matching_finished_outputs) == len(self.jobs)
    return any(o["is_failed"] for o in matching_finished_outputs)

  def stop(self):
    self.Runner.stop_jobs(self.jobs, self.job_options)
