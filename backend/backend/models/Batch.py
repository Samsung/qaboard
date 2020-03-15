"""
Represents SLAM runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import re
import datetime
import json
import subprocess
from pathlib import Path
from functools import lru_cache

from requests.utils import quote
import numpy as np
from sqlalchemy import ForeignKey, Integer, String, DateTime, JSON
from sqlalchemy import UniqueConstraint, Column
from sqlalchemy.orm import relationship

from qaboard.conventions import slugify

from backend.models import Base, Output



class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)
  data = Column(JSON(), default={})

  ci_commit_id = Column(Integer(), ForeignKey('ci_commits.id'), index=True)
  ci_commit = relationship("CiCommit", back_populates="batches", foreign_keys=[ci_commit_id])

  # identifies eg whether it is the default CI job, or a tuning experiment...
  label = Column(String(), default="default")

  __table_args__ = (UniqueConstraint('ci_commit_id', 'label', name='_ci_commit__label'),)

  outputs = relationship("Output",
                         back_populates="batch",
                         cascade="all, delete-orphan"
                        )

  @property
  def output_folder(self):
    return Path('output') if self.label == 'default' else Path('tuning') / slugify(self.label)

  @property
  def output_dir(self):
    return self.ci_commit.commit_dir / self.output_folder

  @property
  @lru_cache()
  def output_dir_url(self):
    return f"{self.ci_commit.commit_dir_url}/{quote(str(self.output_folder))}"

  def metrics(self, metric, outputs=None):
    """Returns a list of results - for a chosen metric - over the commit's outputs.
    The optionnal `outputs` parameter makes it almost like a static method.
    It helps with scope issues in the templates.
    """
    if not outputs:
      outputs = self.outputs
    return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

  def to_dict(self, with_outputs=False, with_aggregation=None):
    metrics_to_aggregate  = with_aggregation if with_aggregation else {}
    if with_outputs:
      outputs = {'outputs': {o.id: o.to_dict() for o in self.outputs}}
    else:
      # we don't even supply a key, to make it easier for the JS code to
      # just update the batch properties when it get the full version  
      outputs = {}
    return {
        'id': self.id,
        'commit_id': self.ci_commit.hexsha,
        'label': self.label,
        'created_date': self.created_date.isoformat(),
        'data': self.data if self.data else {}, # None check for old batches (todo: migrate them properly)
        'output_dir_url': self.output_dir_url,

        'aggregated_metrics': aggregated_metrics(self.outputs, metrics_to_aggregate),
        'valid_outputs': len([o for o in self.outputs if not o.is_failed and not o.is_pending]),
        'pending_outputs': len([o for o in self.outputs if o.is_pending]),
        'running_outputs': len([o for o in self.outputs if o.is_running]),
        'failed_outputs': len([o for o in self.outputs if o.is_failed]),
        'deleted_outputs': len([o for o in self.outputs if o.deleted]),
        **outputs,
    }

  def __repr__(self):
    return (f"<Batch commmit='{self.ci_commit.hexsha}' "
            f"label='{self.label}' "
            f"outputs={len(self.outputs)} />")

  def rename(self, label, db_session):
    assert not any([o.is_pending for o in self.outputs])
    # For now we could be computing those dirs based on the label...
    # We avoid moving moving anything...
    for output in self.outputs:
      output.output_dir_override = str(output.output_dir)
    self.label = label
    db_session.add(self)
    db_session.commit()

  def redo(self, only_deleted=False):
    for output in self.outputs:
      if only_deleted and not output.deleted:
        continue
      output.redo()

  def stop(self):
    # TODO: can we after the stop() just mark all outputs as is_pending:False ?
    errors = []
    for command_id, command in self.data.get('commands', {}).items():
      from qaboard.runners.job import JobGroup
      # Default to something reasonnable, but it likely won't work out-of-the-box for all runners
      # if the stop dosn't only use the command_id...
      jobs = JobGroup(job_options={"type": "local", "command_id": command_id, **command})
      try:
        jobs.stop()
      except Exception as e:
        errors.append(str(e))
        continue
    if errors:
      return {"error": errors}
    else:
      return {}

  def delete(self, session, only_failed=False):
    """
    Hard delete the batch and all related outputs.
    Note: You should call .stop() before
    """
    for output in self.outputs:
      if only_failed and not output.deleted:
        continue
      output.delete(soft=False)
      session.delete(output)
    session.delete(self)
    session.commit()


# TODO: refactored with proper SQL
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
    aggregated[f'{metric}_median'] = np.median(values) if has_values else np.NaN
    aggregated[f'{metric}_average'] = np.average(values) if has_values else np.NaN
    # aggregated[f'{metric}_pc_bad'] = np.mean(values < treshold) if has_values else np.NaN
    # TODO: Use qatools to know if smaller_is_better
    # aggregated[f'{metric}_threshold_bad'] = treshold
  # Remove NaN values
  return {k: v for k, v in aggregated.items() if v == v}
