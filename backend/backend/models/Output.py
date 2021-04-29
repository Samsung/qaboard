"""
Describes an Output from `qa run`.
"""
import os
import re
import json
import hashlib
import fnmatch
import datetime
import subprocess
from pathlib import Path

from requests.utils import quote
from sqlalchemy import Column, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound
from sqlalchemy import text, and_, Integer, String, Float, Boolean, DateTime, JSON
from sqlalchemy.dialects.postgresql import JSONB

from qaboard.conventions import slugify, slugify_hash, make_hash, serialize_config
from qaboard.utils import save_outputs_manifest
from qaboard.api import dir_to_url

from backend.models import Base
from backend.fs_utils import rmtree




class Output(Base):
  __tablename__ = 'outputs'
  id = Column(Integer, primary_key=True)

  batch_id = Column(Integer(), ForeignKey('batches.id'), index=True)
  batch = relationship("Batch", back_populates="outputs",)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, index=True) # TODO make it desc
  # when we delete an output we still keep the metadata and manifest
  # to *really* delete it, feel free to delete Output.output_dir and remove the row
  deleted = Column(Boolean(), default=False)


  ####  Where results are stored (eg logs, images, 6dof, whatever)
  # It is easier if there is a centralized way of storing results, but
  # we let people override this to use disk with different quotas
  # or even random folder (like for the CIS projects) 
  output_dir_override = Column(String(), index=True)
  #### What we ran
  # Different output types (slam/6dof, cis/siemens...) are visualized differently
  output_type = Column(String())
  test_input_id = Column(Integer(), ForeignKey('test_inputs.id'), index=True)
  test_input = relationship("TestInput", lazy='joined', back_populates="outputs")

  platform = Column(String())
  configurations = Column(JSONB(), nullable=False, default=list, server_default='[]')
  extra_parameters = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  # https://stackoverflow.com/questions/6626810/multiple-columns-index-when-using-the-declarative-orm-extension-of-sqlalchemy
  # CREATE INDEX CONCURRENTLY idx_outputs_config_params ON outputs (batch_id, test_input_id, configurations, extra_parameters, platform)
  # CREATE INDEX CONCURRENTLY idx_outputs_configurations ON outputs (configurations)
  # CREATE INDEX CONCURRENTLY idx_outputs_extra_parameters ON outputs (extra_parameters)
  __table_args__ = (
    # https://stackoverflow.com/questions/30885846/how-to-create-jsonb-index-using-gin-on-sqlalchemy
    # https://www.postgresql.org/docs/8.3/indexes-opclass.html
    # CREATE INDEX idx_outputs_data_user ON outputs((data -> 'user'));
    Index('idx_outputs_data_user', text("(data->'user')")),#, postgresql_ops={'user': 'text_pattern_ops'}),
    Index('idx_outputs_filter', "batch_id", "test_input_id", "platform"),
    # we can't create an btree index on everything because JSON values can be big
    # https://github.com/doorkeeper-gem/doorkeeper/wiki/How-to-fix-PostgreSQL-error-on-index-row-size
    # https://dba.stackexchange.com/questions/162820/values-larger-than-1-3-of-a-buffer-page-cannot-be-indexed
    # Index('idx_outputs_filter', "batch_id", "test_input_id", "configurations", "extra_parameters", "platform"),
    # Note: we can't use ,postgresql_using='hash' for multiple columns
    # Index('idx_outputs_configurations', "configurations", postgresql_using='hash'),
    # Index('idx_outputs_extra_parameters', "extra_parameters", postgresql_using='hash'),
    # but we could for single columns..
  )

  #### How good we ran
  is_pending = Column(Boolean(), default=False)
  is_running = Column(Boolean(), default=False) # a running ouput is still pending...
  is_failed = Column(Boolean(), default=False)

  metrics = Column(JSON(), nullable=False, default=dict, server_default='{}')
  data = Column(JSON(), nullable=False, default=dict, server_default='{}')


  def copy(self):
    o = Output()
    o.batch_id = self.batch_id
    o.batch = self.batch
    o.created_date = self.created_date
    o.output_dir_override = self.output_dir_override
    o.output_type = self.output_type
    o.test_input_id = self.test_input_id
    o.test_input = self.test_input
    o.platform = self.platform
    o.configurations = self.configurations
    o.extra_parameters = self.extra_parameters
    o.is_pending = self.is_pending
    o.is_running = self.is_running
    o.is_failed = self.is_failed
    o.metrics = self.metrics
    o.data = self.data
    return o

  @property
  def configuration(self):
    return serialize_config(self.configurations)

  @property
  def output_folder(self):
    full_configurations = [self.platform] if self.platform != 'linux' else []
    full_configurations.extend([*self.configurations, self.extra_parameters])
    return f'{slugify_hash(full_configurations, maxlength=16)}/{self.test_input.output_folder}'

  @property
  def output_dir(self):
    if self.output_dir_override is not None:
      return Path(self.output_dir_override)
    return self.batch.batch_dir / self.output_folder

  @property
  def output_dir_url(self):
    return dir_to_url(self.output_dir)

  def __repr__(self):
    return (f"[Output "
           f"ci_commit.hexsha='{self.batch.ci_commit.hexsha[:8]}' "
           f"batch='{self.batch.label}' "
           f"platform='{self.platform}' "
           f"config='{self.configuration}' "
           f"filename='{self.test_input.filename}' /]")

  def to_dict(self):
    cols = [
     'id',
     'output_type',
     'platform',
     'configurations',
     'extra_parameters',
     'metrics',
     'is_failed',
     'is_pending',
     'is_running',
     'data',
     'deleted',
    ]
    as_dict = {c: getattr(self, c) for c in cols}
    return {
        **as_dict,
        'created_date': self.created_date.isoformat(),
        'output_dir_url': self.output_dir_url,
        'test_input_database': str(self.test_input.database),
        'test_input_path': str(self.test_input.path),
        'test_input_metadata': self.test_input.data['metadata'] if (self.test_input.data and 'metadata' in self.test_input.data) else {},
    }

  @staticmethod
  def get_or_create(session, **kwargs):
    try:
      return session.query(Output).filter(
          and_(
              Output.batch_id == kwargs['batch'].id,
              Output.test_input_id == kwargs['test_input'].id,
              Output.platform == kwargs['platform'],
              Output.configurations == kwargs['configurations'],
              Output.extra_parameters == kwargs['extra_parameters'],
          )
      ).one()
    except NoResultFound:
      output = Output(
          batch=kwargs['batch'],
          test_input=kwargs['test_input'],
          platform=kwargs['platform'],
          configurations=kwargs['configurations'],
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
              Output.configurations == kwargs['configurations'],
              Output.extra_parameters == kwargs['extra_parameters'],
          )
      ).delete()
      output = Output(
          batch=kwargs['batch'],
          test_input=kwargs['test_input'],
          platform=kwargs['platform'],
          configurations=kwargs['configurations'],
          extra_parameters=kwargs['extra_parameters'],
      )
      session.add(output)
      session.commit()
      return output


  def redo(self):
    extra_parameters = json.dumps(self.extra_parameters, sort_keys=True)
    job_options = self.data.get("job_options", {})
    job_options_cli = ""
    if not job_options:
      # for backward compatibility, it's a good defaut at SIRC
      job_options_cli = "--lsf-max-memory 20000"
    elif job_options['type'] == "lsf":
      # TODO: support other runners... maybe create an ad-hoc functions in their classes...
      if 'queue' in job_options:
        job_options_cli += f"--lsf-queue '{job_options['queue']}'"
      if 'max_memory' in job_options and job_options['max_memory'] != 0:
        job_options_cli += f"--lsf-max-memory '{job_options['max_memory']}'"
      if 'resources' in job_options and job_options['resources']:
        job_options_cli += f"--lsf-resources '{job_options['resources']}'"
      if 'max_threads' in job_options and job_options['max_threads'] != 0:
        job_options_cli += f"--lsf-threads '{job_options['max_threads']}'"
    command = ' '.join([
      'qa',
      f'--label "{self.batch.label}"',
      f"--configuration '{self.configuration}'",
      f"--database '{self.test_input.database}'",
      f"--type '{self.output_type}'",
      f"--tuning '{extra_parameters}'",
      'batch',
      '--no-wait',
      job_options_cli,
      '--action-on-existing=run',
      '--action-on-pending=run',
      f'"{self.test_input.path}"',
      # FIXME: if forwarded_args in parsed(self.configuration), add it..
    ])
    script = '\n'.join([
      '#!/bin/bash',
      'set -ex',
      # needed...
      f"export CI=true;",
      f"export GIT_COMMIT='{self.batch.ci_commit.hexsha}';",
      f"export QA_OUTPUTS_COMMIT='{self.batch.ci_commit.outputs_dir}'",
      f"export QABOARD_TUNING=true;",
      f'export QA_BATCH_COMMAND_HIDE_LOGS=true',
      "",
      # get the env right
      f'umask 0',
      f'mkdir -p "{self.batch.ci_commit.artifacts_dir}"',
      f'cd "{self.batch.ci_commit.artifacts_dir}"',
      'set +ex',
      '[[ -f ".envrc" ]] && source .envrc',
      '[[ -f "../.envrc" ]] && source ../.envrc',
      '[[ -f "../../.envrc" ]] && source ../../.envrc',
      '[[ -f "../../../.envrc" ]] && source ../../../.envrc',
      'set -ex',
      command,
    ])
    if not self.output_dir.exists():
      self.output_dir.mkdir(parents=True)
    logs_path = self.output_dir / 'log.txt'
    script_path = self.output_dir / 'redo.sh'
    with script_path.open('w') as f:
      f.write(script)
    print(f'"{script_path}"')
    p = subprocess.run(f'bash "{script_path}" > "{logs_path}" 2>&1', shell=True)
    success = p.returncode == 0
    return success


  def delete(self, soft=True, ignore=None, dryrun=False):
    """
    Delete the output's output files.
    It's soft by default, in that we still keep the metadata.
    For a full hard delete, you'll also want to `session.delete(output)`
    """
    output_dir = self.output_dir
    if not output_dir.exists():
      self.deleted = True
      print("Empty output dir")
      return

    if not soft:
      print(output_dir)
      rmtree(output_dir)
    else:
      # If a run crashes, or in case of network issues, the manifests may not be updated...
      manifest_path = output_dir / 'manifest.outputs.json'
      if manifest_path.exists():
        with manifest_path.open() as f:
          files = json.load(f)
        for file in files.keys():
          if file in ['manifest.outputs.json', 'manifest.inputs.json']:
            continue
          if ignore:
            if any([fnmatch.fnmatch(file, i) for i in ignore]):
              continue
          output_file = output_dir / file
          if not output_file.exists():
            continue
          print(f'{output_file}')
          if not dryrun:
            rmtree(output_dir)
    self.deleted = True


  def update_manifest(self, compute_hashes=True):
    qatools_config = self.batch.ci_commit.project.data.get('qatools_config', {})
    os.umask(0)
    return save_outputs_manifest(self.output_dir, config=qatools_config, compute_hashes=compute_hashes)

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
