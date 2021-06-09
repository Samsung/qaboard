"""
Represents runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import uuid
import datetime
from pathlib import Path

import numpy as np
from sqlalchemy import ForeignKey, Integer, String, DateTime, JSON
from sqlalchemy import UniqueConstraint, Column
from sqlalchemy.orm import relationship

from qaboard.conventions import batch_folder_name
from qaboard.api import dir_to_url

from backend.models import Base



class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
  data = Column(JSON(), nullable=False, default=dict, server_default='{}')

  ci_commit_id = Column(Integer(), ForeignKey('ci_commits.id'), index=True)
  ci_commit = relationship("CiCommit", back_populates="batches", foreign_keys=[ci_commit_id])

  # identifies eg whether it is the default CI job, or a tuning experiment...
  label = Column(String(), default="default")

  __table_args__ = (UniqueConstraint('ci_commit_id', 'label', name='_ci_commit__label'),)

  batch_dir_override = Column(String())

  outputs = relationship("Output",
                         back_populates="batch",
                         cascade="all, delete-orphan"
                        )


  @property
  def batch_dir(self):
    if self.batch_dir_override:
      return Path(self.batch_dir_override)
    else:
      return self.ci_commit.outputs_dir / batch_folder_name(self.label)


  def to_dict(self, with_outputs=False, with_aggregation=None):
    metrics_to_aggregate  = with_aggregation if with_aggregation else {}
    if with_outputs:
      outputs = {'outputs': {o.id: o.to_dict() for o in self.outputs}}
    else:
      outputs = {}
    valid_outputs = 0
    pending_outputs = 0
    running_outputs = 0
    failed_outputs = 0
    deleted_outputs = 0
    for o in self.outputs:
      if not o.is_failed and not o.is_pending:
        valid_outputs += 1
      if o.is_pending:
        pending_outputs += 1
      if o.is_running:
        running_outputs += 1
      if o.is_failed:
        failed_outputs += 1
      if o.deleted:
        deleted_outputs += 1
    return {
        'id': self.id,
        'commit_id': self.ci_commit.hexsha,
        'label': self.label,
        'created_date': self.created_date.isoformat(),
        'data': self.data if self.data else {}, # None check for old batches (todo: migrate them properly)
        'batch_dir_url': dir_to_url(self.batch_dir),

        'aggregated_metrics': aggregated_metrics(self.outputs, metrics_to_aggregate),
        'valid_outputs': valid_outputs,
        'pending_outputs': pending_outputs,
        'running_outputs': running_outputs,
        'failed_outputs': failed_outputs,
        'deleted_outputs': deleted_outputs,
        **outputs,
    }

  def __repr__(self):
    return (f"<Batch commmit='{self.ci_commit.hexsha}' "
            f"label='{self.label}' "
            f"outputs={len(self.outputs)} />")

  def rename(self, label, db_session):
    assert not any([o.is_pending for o in self.outputs])
    # Note that the output directories will still be based on the old label, we don't move/copy anything
    self.label = label
    db_session.add(self)
    db_session.commit()

  def redo(self, only_failed=False, only_deleted=False):
    success = True
    # in case it was deleted without QA-Board being made aware
    if not self.ci_commit.artifacts_dir.exists():
      print("Restoring artifacts")
      self.ci_commit.save_artifacts()
    command_id = uuid.uuid4()
    for output in self.outputs:
      if only_failed and not output.is_failed:
        continue
      if only_deleted and not output.deleted:
        continue
      output_success = output.redo(command_id=command_id)
      success = success and output_success
    return success

  def stop(self):
    if not any([o.is_pending for o in self.outputs]):
      return {}

    # TODO: it's a bit overkill to stop everything, and may even yield errors...
    # TODO: can we after the stop() just mark all outputs as is_pending:False ?
    errors = []
    for command_id, command in self.data.get('commands', {}).items():
      print(f"stopping {command['runner']} {command_id}")
      from qaboard.runners.job import JobGroup
      # Default to something reasonnable, but it likely won't work out-of-the-box for all runners
      jobs = JobGroup(job_options={
        "type": command['runner'],
        "command_id": command_id,
        **command,
      })
      try:
        jobs.stop()
      except Exception as e:
        errors.append(str(e))
        continue
    if errors:
      return {"error": errors}
    else:
      return {}

  def delete(self, session, soft=False, only_failed=False):
    """
    Delete the batch and all related outputs.
    By default it will be a "hard" delete where the metadata+files are deleted from the database/disk.
    With soft deletes, only the files are deleted.
    Note: You should call .stop() before.
    """
    still_has_outputs = False
    for output in self.outputs:
      if only_failed and not output.is_failed:
        still_has_outputs = True
        continue
      output.delete(soft=soft)
      if not soft:
        session.delete(output)
    if not still_has_outputs and not soft:
      session.delete(self)
    session.commit()


# TODO: refactor with proper SQL, or use triggers to keep updated
def aggregated_metrics(outputs, metrics_to_aggregate):
  if not metrics_to_aggregate:
    return {}

  valid_outputs = [o for o in outputs if not o.is_failed and not o.is_pending]
  aggregated = {}
  for metric, treshold in metrics_to_aggregate.items():
    values = np.array([
        o.metrics[metric] for o in valid_outputs
        if metric in o.metrics and not o.metrics[metric] is None
    ])
    has_values = values.shape[0]>0
    try:
      aggregated[f'{metric}_median'] = np.median(values) if has_values else np.NaN
      aggregated[f'{metric}_average'] = np.average(values) if has_values else np.NaN
      # aggregated[f'{metric}_pc_bad'] = np.mean(values < treshold) if has_values else np.NaN
    except:
      continue
    # TODO: Use metric metadata to know if smaller_is_better, or pass the info in metrics_to_aggregate 
    # aggregated[f'{metric}_threshold_bad'] = treshold
  # Remove NaN values
  return {k: v for k, v in aggregated.items() if v == v}
