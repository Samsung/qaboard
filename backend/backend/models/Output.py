"""
Describes an Output from `qa run`.
"""
import os
import json
import fnmatch
import datetime
from pathlib import Path

from sqlalchemy import Column, ForeignKey, Index
from sqlalchemy.orm import relationship
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound
from sqlalchemy import text, and_, Integer, String, Boolean, DateTime, JSON
from sqlalchemy.dialects.postgresql import JSONB

from qaboard.conventions import slugify_hash, serialize_config
from qaboard.utils import save_outputs_manifest
from qaboard.api import dir_to_url

from backend.models import Base
from backend.fs_utils import rm_empty_parents, rmtree, mkdir_shared, chmod_shared
from backend.storage import check_storage_path, check_inside




def iso_utc(date):
  return f"{date.isoformat()}Z" if date else None


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
    # ProgrammingError: (psycopg2.errors.UndefinedObject) data type json has no default operator class for access method "btree"
    # https://sqlalche.me/e/14/f405
    Index('idx_outputs_data_user', text("(data->>'user')")),#, postgresql_ops={'user': 'text_pattern_ops'}),
    Index('idx_outputs_filter', "batch_id", "test_input_id", "platform"),
    # The file browser finds the run a folder belongs to
    Index('idx_outputs_output_dir_override', "output_dir_override"),
    # When a run ends, we check if the `qa batch` command that started it has pending runs (backend/notifications/)
    Index('idx_outputs_pending_root_command', text("(data->>'root_command_id')"), postgresql_where=text("is_pending")),
    # What runs now, for "Activity" (backend/run_activity.py): few runs are pending at a time
    Index('ix_outputs_active', 'batch_id', postgresql_where=text("is_pending")),
    # What ended recently. Runs from before we saved when they ended aren't in the index.
    Index('ix_outputs_finished_at', 'finished_at', postgresql_where=text("finished_at IS NOT NULL")),
    Index('idx_outputs_batch_user_storage', 
          "batch_id", 
          text("(data->>'user')"),
          postgresql_where=text("NOT deleted AND (data->>'storage') IS NOT NULL")),
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
  is_running = Column(Boolean(), default=False) # a running output is still pending...
  is_failed = Column(Boolean(), default=False)
  # The latest attempt: when it was queued (e.g. sent to LSF by `qa batch`), started running, and ended.
  # Runs from before we saved them only have created_date. See set_status().
  queued_at = Column(DateTime, nullable=True)
  started_at = Column(DateTime, nullable=True)
  finished_at = Column(DateTime, nullable=True)

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
    o.queued_at = self.queued_at
    o.started_at = self.started_at
    o.finished_at = self.finished_at
    o.metrics = self.metrics
    o.data = self.data
    return o

  @property
  def configuration(self):
    return serialize_config(self.configurations)

  @property
  def output_folder(self):
    full_configurations = [self.platform] if self.platform != 'lsf' else []
    full_configurations.extend([*self.configurations, self.extra_parameters])
    return f'{slugify_hash(full_configurations, maxlength=16)}/{self.test_input.output_folder}'

  @property
  def output_dir(self):
    return self.get_output_dir()

  def get_output_dir(self, batch_dir=None):
    """`batch_dir`: the batch's, if you know it already"""
    if self.output_dir_override is not None:
      return Path(self.output_dir_override)
    return (batch_dir or self.batch.batch_dir) / self.output_folder

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

  def to_dict(self, batch_dir=None):
    """`batch_dir`: the batch's, when serializing many of its outputs"""
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
        **{c: iso_utc(getattr(self, c)) for c in ('queued_at', 'started_at', 'finished_at')},
        'output_dir_url': dir_to_url(self.get_output_dir(batch_dir)),
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
      # This should not happen (e.g. concurrent calls for the same run). We keep the newest, the one runs
      # update now. The others' files may be the same folder: we only delete their rows.
      print('WARNING: MultipleResultsFound')
      newest, *others = session.query(Output).filter(
          and_(
              Output.batch_id == kwargs['batch'].id,
              Output.test_input_id == kwargs['test_input'].id,
              Output.platform == kwargs['platform'],
              Output.configurations == kwargs['configurations'],
              Output.extra_parameters == kwargs['extra_parameters'],
          )
      ).order_by(Output.id.desc()).all()
      for output in others:
        session.delete(output)
      session.commit()
      return newest


  def set_status(self, is_pending, is_running, now=None):
    """
    Updates whether the run is pending (queued or running) and running, and when its latest attempt was queued,
    started and ended: users see what runs now, and admins the load ("Activity").
    """
    now = now or datetime.datetime.utcnow()
    is_running = bool(is_running)
    is_pending = bool(is_pending) or is_running
    was_pending, was_running = bool(self.is_pending), bool(self.is_pending and self.is_running)
    if is_pending:
      if not was_pending:
        # a new attempt, e.g. a redo
        self.queued_at, self.started_at, self.finished_at = now, None, None
      if is_running and not was_running:
        self.started_at = now
        self.queued_at = self.queued_at or now
    elif was_pending or self.finished_at is None:
      self.finished_at = now
    self.is_pending = is_pending
    self.is_running = is_running

  def measure_left(self, output_dir=None, partial=False):
    """
    After deleting files, what's left on disk: soft deletes keep the manifests, and the files they don't list.
    Deleted runs: data.storage_left (users see it in "Storage usage"). Runs whose files were only partly deleted: data.storage.
    """
    from backend.fs_utils import measure
    output_dir = output_dir or self.output_dir
    left = measure(output_dir)["bytes"] if os.path.lexists(output_dir) else 0
    data = dict(self.data or {})
    if partial:
      data['storage'] = left
    else:
      data['storage_left'] = left
      data['deleted_at'] = datetime.datetime.utcnow().isoformat() + 'Z'
    self.data = data
    flag_modified(self, "data")

  def delete(self, soft=True, ignore=None, filter=None, dryrun=False):
    """
    Delete the output's output files.
    It's soft by default, in that we still keep the metadata.
    For a full hard delete, you'll also want to `session.delete(output)`
    Raises UnsafePathError if the output directory is outside the storage folders.
    """
    output_dir = check_storage_path(self.output_dir)
    if not output_dir.exists():
      self.deleted = True
      if not dryrun:
        self.measure_left(output_dir)
      print(f"WARN: already deleted: {output_dir}")
      return

    if not soft:
      print(output_dir)
      if dryrun:
        return
      rmtree(output_dir)
      rm_empty_parents(output_dir)
    else:
      # If a run crashes, or in case of network issues, the manifests may not be updated...
      manifest_path = output_dir / 'manifest.outputs.json'
      if manifest_path.exists():
        try:
          with manifest_path.open() as f:
            files = json.load(f)
        except Exception as e:
            print(f"{e}: corrupted manifest {manifest_path}")
            if dryrun:
              return
            rmtree(output_dir)
            rm_empty_parents(output_dir)
            self.deleted = True
            self.measure_left(output_dir)
            return
        for file in files.keys():
          if file in ['manifest.outputs.json', 'manifest.inputs.json']:
            continue
          if ignore:
            if any([fnmatch.fnmatch(file, i) for i in ignore]):
              continue
          if filter and not fnmatch.fnmatch(file, filter):
            continue
          # manifests are written by users
          output_file = check_inside(output_dir / file, output_dir)
          if not output_file.exists():
            continue
          print(f'{output_file}')
          if not dryrun:
            rmtree(output_file)
            # the folders it leaves empty: the manifest stays in the output's
            rm_empty_parents(output_file)
      else:
        self.delete(soft=False, dryrun=dryrun)
        return
    if dryrun:
      return
    if not filter:
      self.deleted = True
      self.measure_left(output_dir)
    else:
      # only some files were deleted: the run stays, with its new size
      self.measure_left(output_dir, partial=True)


  def update_manifest(self, compute_hashes=True):
    qatools_config = self.batch.ci_commit.project.data.get('qatools_config', {})
    check_storage_path(self.output_dir)
    # users' runs, under their own accounts, rewrite the manifest (and write in the folder if we create it)
    mkdir_shared(self.output_dir)
    manifest = save_outputs_manifest(self.output_dir, config=qatools_config, compute_hashes=compute_hashes)
    chmod_shared(self.output_dir / 'manifest.outputs.json')
    return manifest

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
    self.set_status(False, False)
