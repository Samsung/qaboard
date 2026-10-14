"""
Represents runs belonging to the same commit.
It might by a CI job, or tuning experiments.
"""
import os
import datetime
from pathlib import Path

from sqlalchemy import ForeignKey, Integer, String, DateTime, Float, Numeric, Text, text, literal_column
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import UniqueConstraint, Column
from sqlalchemy.orm import relationship
from sqlalchemy import func, case, and_, cast
from sqlalchemy.exc import DataError

from qaboard.conventions import batch_folder_name
from qaboard.api import dir_to_url

from backend.models import Base, Output
from backend.metrics_aggregation import metric_names
from backend.shell_utils import shell_safe, safe_user_name
from backend.storage import UnsafePathError



def with_log_dir_url(submission):
  """Where the webapp can read the logs of a batch started from QA-Board"""
  try:
    return {**submission, 'log_dir_url': dir_to_url(Path(submission['log_dir']))}
  except Exception:
    return submission


class Batch(Base):
  __tablename__ = 'batches'
  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
  data = Column(
    JSONB(),
    nullable=False,
    default=dict,
    server_default='{}',
    # FIXME?
    # https://stackoverflow.com/questions/38961396/sqlalchemy-set-default-value-for-postgres-json-column
    # says we should use this?
    # default=text("'{}'::jsonb"),
    # server_default=text("'{}'::jsonb"),
  )

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


  def to_dict(self, session, with_outputs=False, with_aggregation=None, stats=None):
    """
    `stats` are the batch's counts of outputs and aggregated metrics, from batches_stats().
    When serializing many batches, compute them all at once and pass them here.
    """
    batch_dir = self.batch_dir
    if with_outputs:
      outputs = {'outputs': {o.id: o.to_dict(batch_dir=batch_dir) for o in self.outputs}}
    else:
      outputs = {}
    if stats is None:
      stats = batches_stats(session, [self.id], with_aggregation).get(self.id, no_stats)
    data = self.data if self.data else {} # None check for old batches (todo: migrate them properly)
    if data.get('submissions'):
      data = {**data, 'submissions': {id: with_log_dir_url(s) for id, s in data['submissions'].items()}}
    return {
        'id': self.id,
        'commit_id': self.ci_commit.hexsha,
        'label': self.label,
        'created_date': self.created_date.isoformat(),
        'data': data,
        'batch_dir_url': dir_to_url(batch_dir),
        **stats,
        **outputs,
    }

  def __repr__(self):
    return (f"<Batch commit='{self.ci_commit.hexsha}' "
            f"label='{self.label}' "
            f"outputs={len(self.outputs)} />")

  def rename(self, label, db_session):
    # Note that the output directories will still be based on the old label, we don't move/copy anything
    self.label = label
    db_session.add(self)
    db_session.commit()

  def stop(self, session):
    if not any([o.is_pending for o in self.outputs]):
      return {}

    # TODO: it's a bit overkill to stop everything, and may even yield errors...
    # TODO: can we after the stop() just mark all outputs as is_pending:False ?
    errors = []
    for command_id, command in self.data.get('commands', {}).items():
      print(f"stopping {command.get('runner')} {command_id}")
      from qaboard.runners.job import JobGroup
      # Batch.data.commands is written by unauthenticated API calls, and the runners
      # use those options to build shell commands (e.g. `bkill` via the LSF bridge).
      # So we only forward the few options needed to stop jobs, after validating them.
      runner = command.get('runner')
      if runner not in ("lsf", "dask", "local", "celery"):
        print(f"WARNING: cannot stop jobs for runner {runner!r}")
        continue
      try:
        job_options = {
          "type": runner,
          "command_id": shell_safe(command_id, "command_id"),
          "bridge": os.environ.get("QA_RUNNERS_LSF_BRIDGE", ""),
        }
        if command.get('user'):
          job_options['user'] = safe_user_name(command['user'])
      except ValueError as e:
        print(f"WARNING: cannot stop jobs for command {command_id!r}: {e}")
        continue
      # We only connect to Dask schedulers we trust
      trusted_schedulers = [s for s in os.environ.get("QABOARD_DASK_SCHEDULERS", "").split(",") if s]
      if runner == "dask" and command.get('scheduler_address') in trusted_schedulers:
        job_options['scheduler_address'] = command['scheduler_address']
      jobs = JobGroup(job_options=job_options)
      try:
        jobs.stop()
      except Exception as e:
        print(e)
        errors.append(str(e))
        continue
    if errors:
      return {"error": errors}
    else:
      for o in self.outputs:
        if o.is_pending:
          o.is_failed = True
          o.is_running = False
          o.is_pending = False
          session.add(o)
      session.commit()
      return {}

  def delete(self, session, soft=False, only_failed=False, filter=None):
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
      try:
        output.delete(soft=soft, filter=filter)
      except UnsafePathError as e:
        # we keep the output, so that admins can see it and its files are not lost
        print(f"WARNING: not deleting {output}: {e}")
        still_has_outputs = True
        continue
      if not soft:
        session.delete(output)
    if not still_has_outputs and not soft:
      session.delete(self)
    session.commit()


no_stats = {
  'aggregated_metrics': {},
  'valid_outputs': 0,
  'pending_outputs': 0,
  'running_outputs': 0,
  'failed_outputs': 0,
  'deleted_outputs': 0,
}
# keeps the query reasonable whatever clients ask for
max_aggregated_metrics = 20


def batches_stats(session, batch_ids, metrics_to_aggregate=None):
  """
  In one query for many batches: their number of outputs per status, and the median
  and average of some metrics over their valid outputs (`metrics_to_aggregate`: {name: target}).
  Returns {batch_id: {'valid_outputs': 10, ..., 'aggregated_metrics': {'loss_median': 0.1, 'loss_average': 0.2}}}
  Batches without outputs are missing.
  """
  if not batch_ids:
    return {}
  # e.g. {"loss": 0.1}, a list of names, or anything clients send
  metrics = metric_names(metrics_to_aggregate)[:max_aggregated_metrics]
  # Output.metrics is JSON, stored as text: reading a key means parsing it. We read each metric once per output
  # (OFFSET 0 keeps postgres from inlining subqueries, it would read them again for each use).
  outputs = (session
    .query(
      Output.batch_id,
      and_(~Output.is_failed, ~Output.is_pending).label('is_valid'),
      # The metrics of runs from old clients, with NULL statuses, count. Deleted runs' don't.
      and_(Output.is_failed.isnot(True), Output.is_pending.isnot(True), Output.deleted.isnot(True)).label('is_aggregated'),
      Output.is_pending, Output.is_running, Output.is_failed, Output.deleted,
      *[Output.metrics[metric].label(f'metric_{index}') for index, metric in enumerate(metrics)],
    )
    .filter(Output.batch_id.in_(batch_ids))
    .offset(0)
    .subquery()
  )
  # We only aggregate numbers (not strings, booleans...), from valid outputs (not failed, pending or deleted),
  # that fit in floats. Aggregates ignore NULLs. Like backend/metrics_aggregation.py, in the same query as the counts.
  def as_float(value):
    number = cast(cast(value, Text), Numeric)
    # nested CASEs: postgres evaluates them in order, but not the terms of AND
    return case((func.json_typeof(value) == 'number', case((func.abs(number) < literal_column('1e308::numeric'), cast(number, Float)))))
  values = (session
    .query(
      outputs,
      *[case((outputs.c.is_aggregated, as_float(outputs.c[f'metric_{index}']))).label(f'value_{index}') for index in range(len(metrics))],
    )
    .offset(0)
    .subquery()
  )
  columns = [
    values.c.batch_id,
    func.sum(case((values.c.is_valid, 1), else_=0)),
    func.sum(case((values.c.is_pending, 1), else_=0)),
    func.sum(case((values.c.is_running, 1), else_=0)),
    func.sum(case((values.c.is_failed, 1), else_=0)),
    func.sum(case((values.c.deleted, 1), else_=0)),
  ]
  for index in range(len(metrics)):
    value = values.c[f'value_{index}']
    columns.append(func.percentile_cont(0.5).within_group(value))
    columns.append(func.avg(value))
  query = session.query(*columns).group_by(values.c.batch_id)
  if metrics:
    try:
      # e.g. numbers too big for floats: we'd rather show batches without metrics than an error
      with session.begin_nested():
        rows = query.all()
    except DataError as e:
      print(f"WARNING: could not aggregate {metrics}: {e}")
      return batches_stats(session, batch_ids)
  else:
    rows = query.all()

  stats = {}
  for batch_id, valid, pending, running, failed, deleted, *aggregates in rows:
    aggregated = {}
    for index, metric in enumerate(metrics):
      median, average = aggregates[2 * index], aggregates[2 * index + 1]
      if median is not None:
        aggregated[f'{metric}_median'] = median
      if average is not None:
        aggregated[f'{metric}_average'] = average
    stats[batch_id] = {
      'aggregated_metrics': aggregated,
      'valid_outputs': valid or 0,
      'pending_outputs': pending or 0,
      'running_outputs': running or 0,
      'failed_outputs': failed or 0,
      'deleted_outputs': deleted or 0,
    }
  return stats
