"""
Represents SLAM runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import datetime
from pathlib import Path

import numpy as np

from sqlalchemy import ForeignKey, Integer, String, Float, Boolean, DateTime
from sqlalchemy import Column, and_
from sqlalchemy.orm import relationship
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound

from slamvizapp.models import Base, Recording, Batch, SlamOutput
from ..utils import filter_slam_outputs

class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)

  ci_commit_id = Column(String(), ForeignKey('ci_commits.id'))
  ci_commit = relationship("CiCommit", back_populates="batches", foreign_keys=[ci_commit_id])

  # identifies eg whether it is the default CI job, or a tuning experiment...
  label = Column(String(), default="default")

  slam_outputs = relationship("SlamOutput", back_populates="batch",
    cascade="all, delete, delete-orphan"
  )

  @property
  def output_folder(self):
    return 'output' if self.label == 'default' else 'tuning' / slugify(self.label)

  @property
  def output_dir(self):
    return self.ci_commit.commit_dir / self.output_folder

  @property
  def output_dir_url(self):
    return self.ci_commit.commit_dir_url / self.output_folder

  def discover_slam_outputs(self, session):
    """Find outputs saved on the disk to initialize the database"""
    slam_outputs = []
    # FIXME: we should also look for unsuccessful runs
    #   we could look into lsf.log and parse it for recoring names
    #   then check whether we have them of not...
    # we look for successful runs
    output_dirs = [p.parent for p in self.output_dir.rglob('metrics.json')]
    for output_dir in output_dirs:
      if self.label!='default': raise NotImplementedError
      platform, configuration, *rel_recording_path = output_dir.relative_to(self.output_dir).parts
      #                      , parameter_id
      # FIXME:
      rel_recording_path = Path(*rel_recording_path)
      rel_recording_path = f'{rel_recording_path}.bin'
      recording = Recording.get_or_create(session, path=rel_recording_path)
      if not recording:
        continue

      # FIXME: we should use the actual parameters used
      # not just the default, but also configuration.json
      slam_output = SlamOutput.get_or_create(session,
        batch=self,
        recording=recording,
        platform=platform,
        configuration=configuration,
        extra_parameters={},
      )
      slam_output.update_metrics_from_file(output_dir/'metrics.json')
      session.add(slam_output)
      session.commit()


  @property
  def valid_slam_outputs(self):
    return [o for o in self.slam_outputs if not o.is_failed and not o.is_pending]

  @property
  def pending_slam_outputs(self):
    return [o for o in self.slam_outputs if o.is_pending]

  @property
  def failed_slam_outputs(self):
    return [o for o in self.slam_outputs if o.is_failed]

  def failures_count(self):
      """Returns an estimate of the number of failed runs"""
      return len([o for o in self.slam_outputs if o.is_failed])

  def aggregated_metrics(self, filename_filter='', filename_exclude=''):
      return aggregated_metrics(filter_slam_outputs(self.valid_slam_outputs, filename_filter, filename_exclude))

  def metrics(self, metric, outputs=None):
      """Returns a list of results - for a chosen metric - over the commit's outputs.
      The optionnal `outputs` parameter makes it almost like a static method. It helps with scope issues in the templates.
      """
      if not outputs:
        outputs = self.slam_outputs
      return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

  def to_dict(self, with_details=False):
    if with_details:
      details = {
        'slam_outputs': {o.id: o.to_dict() for o in self.slam_outputs},
      }
    else:
      details = {}
    return {
      'id': self.id,
      'commit_id': self.ci_commit_id,
      'label': self.label,
      'created_date': self.created_date.isoformat(),

      'aggregated_metrics': {k:v for k,v in self.aggregated_metrics().items() if v==v}, # => is not NaN
      'valid_slam_outputs': len(self.valid_slam_outputs),
      'pending_slam_outputs': len(self.pending_slam_outputs),
      'failed_slam_outputs': len(self.failed_slam_outputs),
      **details,
    }

  def __repr__(self):
    return f"<Batch(commmit='{self.ci_commit.id}' label='{self.label}' slam_outputs={len(self.slam_outputs)}>"

# this should be refactored into SQL
def aggregated_metrics(slam_outputs):
    aggregated = {
        'pc_where_lost_at_least_once': np.mean([m.nb_lost>0 for m in slam_outputs if m.nb_lost]),
        'total_time_lost_pc_mean': np.mean([m.total_time_lost_pc for m in slam_outputs if m.total_time_lost_pc]),
    }
    metrics_to_aggregate = [
      # metric_name, threshold_good 
      ('translation_rmse', 0.01),
      ('translation_aape', 0.01),
      ('translation_drift_pc', 0.01),
      ('rotation_mean', 1.5),
      ('rotation_mean_when_good', 1.5),
      ('translation_aape_when_good', 0.01),
      ('frac_tracking_state_good', .99),
      # ('compute_time_vs_realtime', 1), # FIXME: it's not an attribute so the call will fail
    ]
    for metric, treshold in metrics_to_aggregate:
      values = np.array([getattr(o, metric) for o in slam_outputs if (hasattr(o, metric) and getattr(o, metric))])
      aggregated[f'{metric}_median'] = np.median(values)
      aggregated[f'{metric}_average']= np.average(values)
      aggregated[f'{metric}_pc_bad'] = np.mean(values<treshold)
      aggregated[f'{metric}_threshold_bad'] = treshold
    return aggregated


def slugify(s):
  s_slugified = s
  for c in ' /': # baaaaad
    s_slugified = s_slugified.replace(c, '-')
