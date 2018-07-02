"""
Describes an output from a CI run:
1. How we ran
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


class Output(Base):
  __tablename__ = 'outputs'
  id = Column(Integer, primary_key=True)

  batch_id = Column(Integer(), ForeignKey('batches.id'), index=True)
  batch = relationship("Batch", back_populates="outputs",)
  created_date = Column(DateTime, default=datetime.datetime.utcnow)

  ####  Where results are stored (eg logs, images, 6dof, whatever)
  # It is easier if there is a centralized way of storing results, but
  # we let people override this to use disk with different quotas
  # or even random folder (like for the CIS projects) 
  output_dir_override = Column(String())
  #### What we ran
  # Different output types (slam/6dof, cis/siemens...) are visualized differently
  output_type = Column(String())
  test_input_id = Column(Integer(), ForeignKey('test_inputs.id'))
  test_input = relationship("TestInput", lazy='joined', back_populates="outputs")

  platform = Column(String()) # lsf/s8/...
  # SLAM runs use params.json, $configuration.json (mono/stereo...)
  # For CIS projects it might have other meanings
  configuration = Column(String())
  # Used for tuning
  extra_parameters = Column(JSON(), default={})

  #### How good we ran
  is_pending = Column(Boolean(), default=False)
  is_running = Column(Boolean(), default=False) # in addition to pending
  is_failed = Column(Boolean(), default=False)
  metrics = Column(JSON(), default={})
  data = Column(JSON(), default={})


  # TODO: refactor as SLAM-specific, move into the scrapping code
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
      print(f'[WARNING] Output.update_metrics: failed to read {filepath}')
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
    return Path(self.platform) / self.configuration / parameters_hash[:2] / parameters_hash / self.test_input.output_folder

  @property
  def output_dir(self):
    if self.output_dir_override is not None:
      return Path(self.output_dir_override)
    return self.batch.output_dir / self.output_folder

  @property
  def output_dir_url(self):
    if self.output_dir_override is not None:
      if '/net/f2/algo_archive' in self.output_dir_override:
        return '/s/'/self.output_dir.relative_to('/net/f2')
      elif '/stage/algo_data' in self.output_dir_override:
        return '/s/'/self.output_dir.relative_to('/stage')
      else:
        raise NotImplementedError
    return self.batch.output_dir_url / self.output_folder

  def __repr__(self):
    return (f"<Output "
           f"ci_commit_id='{self.batch.ci_commit_id}' "
           f"batch='{self.batch.label}' "
           f"platform='{self.platform}' "
           f"config='{self.configuration}' "
           f"filename='{self.test_input.filename}' />")

  def to_dict(self):
    cols = [
     'id',
     'output_type',
     'platform',
     'configuration',
     'extra_parameters',
     'metrics',
     'is_failed',
     'is_pending',
     'is_running',
     'data',
    ]
    as_dict = {c: getattr(self, c) for c in cols}
    return {
        **as_dict,
        'output_dir_url': str(self.output_dir_url),
        'test_input_database': str(self.test_input.database),
        'test_input_path': str(self.test_input.path),
        'test_input_tags': self.test_input.data['tags'] if (self.test_input.data and 'tags' in self.test_input.data) else [],
    }

  @staticmethod
  def get_or_create(session, **kwargs):
    extra_parameters_json = type_coerce(kwargs['extra_parameters'], JSON)
    try:
      return session.query(Output).filter(
          and_(
              Output.batch_id == kwargs['batch'].id,
              Output.test_input_id == kwargs['test_input'].id,
              Output.platform == kwargs['platform'],
              Output.configuration == kwargs['configuration'],
              cast(Output.extra_parameters, String) == extra_parameters_json,
          )
      ).one()
    except NoResultFound:
      output = Output(
          batch=kwargs['batch'],
          test_input=kwargs['test_input'],
          platform=kwargs['platform'],
          configuration=kwargs['configuration'],
          extra_parameters=kwargs['extra_parameters'],
      )
      # session.add(output)
      # session.commit()
      return output

    except MultipleResultsFound:
      print('WARNING: MultipleResultsFound')
      # this should not happen. Quick and dirty fix:
      output = session.query(Output).filter(
          and_(
              Output.batch_id == kwargs['batch'].id,
              Output.test_input_id == kwargs['test_input'].id,
              Output.platform == kwargs['platform'],
              Output.configuration == kwargs['configuration'],
              cast(Output.extra_parameters, String) == extra_parameters_json,
          )
      ).delete()
      output = Output(
          batch=kwargs['batch'],
          test_input=kwargs['test_input'],
          platform=kwargs['platform'],
          configuration=kwargs['configuration'],
          extra_parameters=kwargs['extra_parameters'],
      )
      session.add(output)
      session.commit()
      return output
