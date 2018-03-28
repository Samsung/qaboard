"""
Describes an output from a SLAM run:
1. How we ran the SLAM
- what version of the code was used
- on what platform we ran
- what parameters were used
2. What results we got
- quality metrics: drift, RMSE, AAPE...
- what assets are available (debug movies...)
"""
import datetime
import hashlib
import json
from pathlib import Path

from sqlalchemy import Column, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound
from sqlalchemy import and_, Integer, String, Float, Boolean, DateTime, JSON
from sqlalchemy import cast, type_coerce

from slamvizapp.models import Base


class SlamOutput(Base):
  __tablename__ = 'slam_outputs'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)

  # What we ran
  recording_id = Column(Integer(), ForeignKey('recordings.id'))
  recording = relationship("Recording", back_populates="slam_outputs")
  trajectory_length = Column(Float()) # it's not normalized to store it here but..

  batch_id = Column(Integer(), ForeignKey('batches.id'))
  batch = relationship("Batch", back_populates="slam_outputs")

  # How we ran
  recording_id = Column(Integer(), ForeignKey('recordings.id'))
  recording = relationship("Recording", back_populates="slam_outputs")

  platform = Column(String()) # lsf/s8/...
  # SLAM runs use params.json, $configuration.json, and the extra parameters for tuning
  configuration = Column(String()) # mono/stereo/serial/...
  # If we ever want to re-import outputs,
  # we will need to save the association parameters<->hash
  extra_parameters = Column(JSON(), default={})

  # How good we ran
  is_failed = Column(Boolean(), default=False)
  is_pending = Column(Boolean(), default=False)
  # We could imaging stuffing all the columns below into a JSON column named metrics
  latency = Column(Float(), default=None) # 1x = realtime
  computation_time = Column(Float(), default=None) # 1x = realtime
  duration = Column(Float(), default=None) # [seconds] Redundant, but...
  cpu_utilization = Column(Float())
  time_offset_to_groundtruth = Column(Float(), default=None)

  # Tracking quality
  translation_rmse = Column(Float(), default=None)
  translation_aape = Column(Float(), default=None)
  translation_drift = Column(Float(), default=None)
  translation_rmse_pc = Column(Float(), default=None)
  translation_aape_pc = Column(Float(), default=None)
  translation_drift_pc = Column(Float(), default=None)

  rotation_rmse = Column(Float(), default=None)
  rotation_mean = Column(Float(), default=None)
  rotation_drift = Column(Float(), default=None)
  # ...idem computed only when the tracking is good
  translation_aape_during_tracking = Column(Float(), default=None)

  # Loss of tracking
  frac_tracking_state_good = Column(Float(), default=None)
  frac_tracking_state_lost = Column(Float(), default=None)
  frac_tracking_state_imu3 = Column(Float(), default=None)
  frac_tracking_state_imu6 = Column(Float(), default=None)
  total_time_lost_pc = Column(Float(), default=None)
  total_time_lost = Column(Float(), default=None)
  nb_lost = Column(Integer(), default=None)
  median_lost_duration = Column(Float(), default=None)
  translation_aape_when_good = Column(Float(), default=None)
  rotation_mean_when_good = Column(Float(), default=None)
  time_before_first_lost = Column(Float(), default=None)
  time_pc_before_first_lost = Column(Float(), default=None)

  # ...

  # User experience
  # jitter_sum_mabs = Column(Float(), default=None)
  # jitter_sum_mad = Column(Float(), default=None)
  # jitter_sum_std = Column(Float(), default=None)



  def __init__(self, **kwargs):
    # We change the name of a few metrics
    kwargs = remap_metrics(kwargs)
    super(SlamOutput, self).__init__(**kwargs)

  def update_metrics(self, filepath=None):
    """Updates the metrics from a file"""
    if not filepath:
      filepath = self.output_dir / 'metrics.json'
    try:
      with filepath.open() as f:
        metrics = json.load(f)
        metrics = remap_metrics(metrics)
    except:
      print(f'WARNING: failed to read {filepath}')
      # metrics = {'is_failed': True}
      metrics = {}
    for m in metrics:
      setattr(self, m, metrics[m])
    self.is_pending = False


  @property
  def output_folder(self):
    if self.batch.label != 'default':
      parameters_s = json.dumps(self.extra_parameters, sort_keys=True)
      parameters_hash = hashlib.md5(parameters_s.encode()).hexdigest()
    else:
      parameters_hash = ''
    return Path(self.platform) / self.configuration / parameters_hash[:2] / parameters_hash / self.recording.output_folder

  @property
  def output_dir(self):
    return self.batch.output_dir / self.output_folder

  @property
  def output_dir_url(self):
    return self.batch.output_dir_url / self.output_folder

  def __repr__(self):
    return f"<SlamOutput \
              ci_commit_id='{self.batch.ci_commit_id}' \
              batch='{self.batch.label}' \
              platform='{self.platform}' \
              config='{self.configuration}' \
              filename='{self.recording.filename}' />"

  def to_dict(self):
    as_dict = {c.name:getattr(self, c.name) for c in Base.metadata.tables['slam_outputs'].columns}
    return {
        **as_dict,
        'output_dir_url': str(self.output_dir_url),
        'recording_path': str(self.recording.path),
    }

  @staticmethod
  def get_or_create(session, **kwargs):
    extra_parameters_json = type_coerce(kwargs['extra_parameters'], JSON)
    try:
      return session.query(SlamOutput).filter(
          and_(
              SlamOutput.batch_id == kwargs['batch'].id,
              SlamOutput.recording_id == kwargs['recording'].id,
              SlamOutput.platform == kwargs['platform'],
              SlamOutput.configuration == kwargs['configuration'],
              cast(SlamOutput.extra_parameters, String) == extra_parameters_json,
          )
      ).one()
    except NoResultFound:
      slam_output = SlamOutput(
          batch=kwargs['batch'],
          recording=kwargs['recording'],
          platform=kwargs['platform'],
          configuration=kwargs['configuration'],
          extra_parameters=kwargs['extra_parameters'],
      )
      session.add(slam_output)
      session.commit()
      return slam_output

    except MultipleResultsFound:
      print('WARNING: MultipleResultsFound')
      # this should not happen. Quick and dirty fix:
      slam_output = session.query(SlamOutput).filter(
          and_(
              SlamOutput.batch_id == kwargs['batch'].id,
              SlamOutput.recording_id == kwargs['recording'].id,
              SlamOutput.platform == kwargs['platform'],
              SlamOutput.configuration == kwargs['configuration'],
              cast(SlamOutput.extra_parameters, String) == extra_parameters_json,
          )
      ).delete()
      slam_output = SlamOutput(
          batch=kwargs['batch'],
          recording=kwargs['recording'],
          platform=kwargs['platform'],
          configuration=kwargs['configuration'],
          extra_parameters=kwargs['extra_parameters'],
      )
      session.add(slam_output)
      session.commit()
      return slam_output




def remap_metrics(metrics):
  """Use the newer names of a number of metrics"""
  # We remove attributes our model doesn't know.
  # There should be a better way to do this...
  columns = set(c.name for c in Base.metadata.tables['slam_outputs'].columns)
  relationships = set(['recording', 'batch', 'parameters_set'])
  columns = columns | relationships

  remapped_names = {
      'aape':'translation_aape',
      'final_drift': 'final_drift',
      'final_drift_pc':'translation_drift_pc',
  }
  for old, new in remapped_names.items():
    if old in metrics:
      metrics[new] = metrics[old]
  return {k: v for k, v in metrics.items() if k in columns}
