"""
Represents SLAM runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import datetime
import json
from pathlib import Path
from functools import lru_cache

import numpy as np
from sqlalchemy import ForeignKey, Integer, String, DateTime, JSON
from sqlalchemy import Column
from sqlalchemy.orm import relationship

from slamvizapp.models import Base, Output

class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)
  data = Column(JSON(), default={})

  ci_commit_id = Column(String(), ForeignKey('ci_commits.id'), index=True)
  ci_commit = relationship("CiCommit", back_populates="batches", foreign_keys=[ci_commit_id])

  # identifies eg whether it is the default CI job, or a tuning experiment...
  label = Column(String(), default="default")

  outputs = relationship("Output",
                         lazy='joined',
                         back_populates="batch",
                         cascade="all, delete-orphan"
                        )

  # experiments = relationship("Experiment",
  #                            lazy='joined',
  #                            back_populates="batch",
  #                            cascade="all, delete-orphan"
  #                            )

  @property
  def output_folder(self):
    return Path('output') if self.label == 'default' else Path('tuning') / slugify(self.label)

  @property
  def output_dir(self):
    return self.ci_commit.commit_dir / self.output_folder

  @property
  @lru_cache()
  def output_dir_url(self):
    return self.ci_commit.commit_dir_url / self.output_folder

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
        'commit_id': self.ci_commit_id,
        'label': self.label,
        'created_date': self.created_date.isoformat(),
        'data': self.data if self.data else {}, # None check for old batches (todo: migrate them properly)
        'output_dir_url': str(self.output_dir_url),

        'aggregated_metrics': aggregated_metrics(self.outputs, metrics_to_aggregate),
        'valid_outputs': len([o for o in self.outputs if not o.is_failed and not o.is_pending]),
        'pending_outputs': len([o for o in self.outputs if o.is_pending]),
        'running_outputs': len([o for o in self.outputs if o.is_running]),
        'failed_outputs': len([o for o in self.outputs if o.is_failed]),
        **outputs,
    }

  def __repr__(self):
    return (f"<Batch commmit='{self.ci_commit.id}' "
            f"label='{self.label}' "
            f"outputs={len(self.outputs)} />")



# this should be refactored into SQL
def aggregated_metrics(outputs, metrics_to_aggregate):
  valid_outputs = [o for o in outputs if not o.is_failed and not o.is_pending]
  aggregated = {}
  for metric, treshold in metrics_to_aggregate.items():
    values = np.array([
        o.metrics[metric] for o in outputs
        if metric in o.metrics and not o.metrics[metric] is None
    ])
    has_values = values.shape[0]>0
    aggregated[f'{metric}_median'] = np.median(values) if has_values else np.NaN
    aggregated[f'{metric}_average'] = np.average(values) if has_values else np.NaN
    # aggregated[f'{metric}_pc_bad'] = np.mean(values < treshold) if has_values else np.NaN
    # we also don't use qatools so we don't know if smaller_is_better
    # aggregated[f'{metric}_threshold_bad'] = treshold
  # remove NaN values
  return {k: v for k, v in aggregated.items() if v == v}


def slugify(s):
  s_slugified = s
  for c in ' /': # baaaaad
    s_slugified = s_slugified.replace(c, '-')
  return s_slugified

