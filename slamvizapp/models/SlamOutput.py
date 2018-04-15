"""
Describes an output from a SLAM run:
1. How we ran the SLAM
- what version of the code was used
- on what platform we ran
- what parameters were used
2. What results we got
- metrics: drift, RMSE, AAPE...
- what assets are available (debug movies...) [todo]
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
  is_pending = Column(Boolean(), default=False)
  is_running = Column(Boolean(), default=False)
  is_failed = Column(Boolean(), default=False)
  metrics = Column(JSON(), default={})


  def update_metrics(self, filepath=None):
    """Updates the metrics from a file"""
    if not filepath:
      filepath = self.output_dir / 'metrics.json'
    try:
      with filepath.open() as f:
        metrics = json.load(f)
        is_serializable = lambda v: not v != v  # avoid NaN values
        metrics = {k:v for k, v in metrics.items() if is_serializable(v)}
        setattr(self, 'metrics', metrics)
        if 'is_failed' in metrics: setattr(self, 'is_failed', metrics['is_failed'])
    except:
      print(f'[WARNING] SlamOutput.update_metrics: failed to read {filepath}')
      # we *could* return False then consider the run crashed if more than X time has passed...
      # metrics = {'is_failed': True}
      # metrics = {}
    self.is_pending = False
    self.is_running = False


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
