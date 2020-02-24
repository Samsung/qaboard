# https://stackoverflow.com/a/33533514/5993501
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any, Callable

from ..run import RunContext 
from ..conventions import url_to_dir
from ..api import get_outputs, notify_qa_database

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


  def start(self, blocking=True, qa_context: Optional[Dict[str, Any]] = None) -> bool:
    """
    Starts the jobs, and returns whether at least one failed.
    """
    if not self.jobs:
      return False
    self.Runner.start_jobs(self.jobs, self.job_options, blocking)

    # Note: we used to always do as below, it's OK but makes many network requests
    # return any(job.is_failed(verbose=True) for job in self.jobs)

    # Note: We get all outputs in the batch, some not started in this command...
    finished_outputs = get_outputs(qa_context)
    if not finished_outputs:
      # If we don't have jobs, either we were offline or something aweful happenned
      return any(job.run_context.is_failed(verbose=True) for job in self.jobs)

    # Here we add the matching outputs as job.qaboard_output
    outputdir_to_qaboard_output = {url_to_dir(o['output_dir_url']): o for o in finished_outputs.values()}
    for job in self.jobs:
      assert job.run_context.output_dir in outputdir_to_qaboard_output
      job.qaboard_output = outputdir_to_qaboard_output[job.run_context.output_dir]


    # If runs are SIGKILL'ed, they never get a chance to update that they are done
    # it happens often when users use a lot of memory and some task queue manager gets angry 
    jobs_with_pending_outputs = [j for j in self.jobs if j.qaboard_output['is_pending']]
    for j in jobs_with_pending_outputs:
      notify_qa_database(**{
        **qa_context,
        **j.run_context.obj, # for now we don't want to worry about backward compatibility, and input_path being abs vs relative...
        "is_pending": False,
        "is_failed": True, # we know something went wrong
      })

    return any(j.qaboard_output["is_failed"] for j in self.jobs)

    # we could do it here

  def stop(self):
    self.Runner.stop_jobs(self.jobs, self.job_options)
