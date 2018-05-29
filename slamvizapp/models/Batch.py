"""
Represents SLAM runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import datetime
import json
from pathlib import Path

import numpy as np

from sqlalchemy import ForeignKey, Integer, String, DateTime
from sqlalchemy import Column
from sqlalchemy.orm import relationship

from slamvizapp.models import Base, TestInput, Output
from ..utils import filter_outputs
from ..config import default_recordings_directory

class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)

  ci_commit_id = Column(String(), ForeignKey('ci_commits.id'))
  ci_commit = relationship("CiCommit", back_populates="batches", foreign_keys=[ci_commit_id])

  # identifies eg whether it is the default CI job, or a tuning experiment...
  label = Column(String(), default="default")

  outputs = relationship("Output", back_populates="batch",
                              cascade="all, delete, delete-orphan"
                             )

  @property
  def output_folder(self):
    print
    return Path('output') if self.label == 'default' else Path('tuning') / slugify(self.label)

  @property
  def output_dir(self):
    return self.ci_commit.commit_dir / self.output_folder

  @property
  def output_dir_url(self):
    return self.ci_commit.commit_dir_url / self.output_folder

  def discover_outputs(self, session):
    """Find outputs saved on the disk to initialize the database"""
    if self.ci_commit.project.id == 'dvs/psp_swip':
      self.discover_outputs_slam(session)
    else:
      self.discover_outputs_cis(session)


  def discover_outputs_slam(self, session):
    """Find outputs saved on the disk to initialize the database"""
    # FIXME: we should also look for unsuccessful runs
    #   we could look into lsf.log and parse it for recording names
    #   then check whether we have them of not...
    # we look for successful runs
    output_dirs = [p.parent for p in self.output_dir.rglob('metrics.json')]
    for output_dir in output_dirs:
      if self.label != 'default': raise NotImplementedError
      platform, configuration, *rel_input_path = output_dir.relative_to(self.output_dir).parts
      # FIXME:                 , parameter_id
      rel_input_path = Path(*rel_input_path)
      rel_input_path = f'{rel_input_path}.bin'
      test_input = TestInput.get_or_create(session, database=default_recordings_directory, path=rel_input_path)
      if not test_input:
        continue

      # FIXME: we should use the actual parameters used
      # not just the default, but also configuration.json
      output = Output.get_or_create(session,
                                             batch=self,
                                             test_input=test_input,
                                             platform=platform,
                                             configuration=configuration,
                                             extra_parameters={},
                                            )
      output.update_metrics(output_dir/'metrics.json')
      session.add(output)
      session.commit()

  def discover_outputs_cis(self, session):
    """Find outputs saved on the disk to initialize the database"""
    outputs_dir = Path(self.ci_commit.commit_dir_override)
    for output_description in outputs_dir.glob('*_job_description.json'):
      print(output_description)
      with output_description.open('r') as f:
        data = json.load(f)
        print(data)
        # input_picture_path_format => \\f2\\algo_archive\\ISP_Database\\Turbo_Database\
        test_input = TestInput.get_or_create(session, database=default_recordings_directory, path=data['input_picture_path_format'])
        # data['save_config_folder_name']
        # input_picture_path_format
        output = Output.get_or_create(session,
                                             batch=self,
                                             test_input=test_input,
                                             platform='CDE',
                                             configuration=data['configuration'],
                                             extra_parameters={},
                                            )
        print(output)
        # session.add(output)
        # session.commit()

  def aggregated_metrics(self, filename_filter='', filename_exclude=''):
    return aggregated_metrics(
        filter_outputs([o for o in self.outputs if not o.is_failed and not o.is_pending], filename_filter, filename_exclude)
    )

  def metrics(self, metric, outputs=None):
    """Returns a list of results - for a chosen metric - over the commit's outputs.
    The optionnal `outputs` parameter makes it almost like a static method.
    It helps with scope issues in the templates.
    """
    if not outputs:
      outputs = self.outputs
    return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

  def to_dict(self, with_details=False):
    if with_details:
      details = {
          'outputs': {o.id: o.to_dict() for o in self.outputs},
      }
    else:
      details = {}
    return {
        'id': self.id,
        'commit_id': self.ci_commit_id,
        'label': self.label,
        'created_date': self.created_date.isoformat(),

        # v == v means is not NaN
        'aggregated_metrics': {k: v for k, v in self.aggregated_metrics().items() if v == v},
        'valid_outputs': len([o for o in self.outputs if not o.is_failed and not o.is_pending]),
        'pending_outputs': len([o for o in self.outputs if o.is_pending]),
        'running_outputs': len([o for o in self.outputs if o.is_running]),
        'failed_outputs': len([o for o in self.outputs if o.is_failed]),
        **details,
    }

  def __repr__(self):
    return f"<Batch(commmit='{self.ci_commit.id}' \
                    label='{self.label}' \
                    outputs={len(self.outputs)} />"

# this should be refactored into SQL
def aggregated_metrics(outputs):
  aggregated = {
      # 'pc_where_lost_at_least_once': np.mean([ o.metrics['nb_lost'] > 0
      #                                        for o in outputs
      #                                        if 'nb_lost' in o.metrics and not o.metrics['nb_lost'] is None]),
      # 'total_time_lost_pc_mean': np.mean([
      #     o.metrics['total_time_lost_pc']
      #     for o in outputs
      #     if 'total_time_lost_pc' in o.metrics and not o.metrics['total_time_lost_pc'] is None
      # ]),
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
    values = np.array([
        o.metrics[metric] for o in outputs
        if metric in o.metrics and not o.metrics[metric] is None
    ])
    has_values = values.shape[0]>0
    aggregated[f'{metric}_median'] = np.median(values) if has_values else np.NaN
    aggregated[f'{metric}_average'] = np.average(values) if has_values else np.NaN
    # aggregated[f'{metric}_pc_bad'] = np.mean(values < treshold) if has_values else np.NaN
    aggregated[f'{metric}_threshold_bad'] = treshold
  return aggregated


def slugify(s):
  s_slugified = s
  for c in ' /': # baaaaad
    s_slugified = s_slugified.replace(c, '-')
  return s_slugified
