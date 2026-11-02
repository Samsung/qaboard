"""
How jobs say what they do: logs, counters and errors. The same job code reports to the terminal (the CLI scripts),
or to the database (the worker), where the web app reads them.

Errors never stop a job: it records them, one row each, and moves on. They say what failed, where, and who
owns the files, so that admins can fix the permissions and run the job again.
"""
import os
import re
import datetime
import traceback
from typing import Optional

import click
from sqlalchemy import text

from ..storage import UnsafePathError


LOG_LINES = 300  # kept in jobs.log
MAX_ERRORS = 20_000  # error rows per job: more are only counted
FLUSH_EVERY = 2  # seconds


def utcnow():
  return datetime.datetime.utcnow()


# rmtree (backend/fs_utils.py) raises "ERROR <reason>: Could not remove: <path>",
# CiCommit.delete reports "Could not remove <path>: <error>"
could_not_remove = re.compile(r'Could not remove: (?P<path>.+)$')
could_not_remove_artifact = re.compile(r'^Could not remove (?P<path>/[^:]+):')


def error_kind(error: BaseException) -> str:
  if isinstance(error, UnsafePathError):
    return 'unsafe_path'
  if isinstance(error, PermissionError):
    return 'permission'
  message = str(error)
  if 'is not inside the storage folders' in message:
    return 'unsafe_path'
  if 'Permission denied' in message or 'Operation not permitted' in message or 'Errno 13' in message or 'Errno 1]' in message:
    return 'permission'
  if 'Read-only file system' in message:
    return 'permission'
  return 'other'


def failed_path(error: BaseException, default=None) -> Optional[str]:
  """The file that could not be deleted, often deeper than the folder we tried to delete"""
  for pattern in (could_not_remove, could_not_remove_artifact):
    match = pattern.search(str(error))
    if match:
      return match.group('path').strip()
  filename = getattr(error, 'filename', None)
  return str(filename) if filename else (str(default) if default else None)


def owner(path) -> Optional[str]:
  if not path:
    return None
  try:
    uid = os.lstat(path).st_uid
  except OSError:
    return None
  from .. import accounts
  return accounts.owner_name(uid)


class Reporter:
  """Counters, logs and errors of a job. Subclasses decide where they go."""
  def __init__(self):
    self.progress = {}
    self.nb_errors = 0

  def log(self, message: str, level: str = 'info'):
    raise NotImplementedError

  def add(self, **counters):
    for key, value in counters.items():
      self.progress[key] = self.progress.get(key, 0) + value

  def set(self, **values):
    self.progress.update(values)

  def error(self, kind: str, message: str, path=None, project_id=None, batch_id=None, output_id=None, owner=None):
    self.nb_errors += 1
    errors = self.progress.setdefault('errors', {})
    errors[kind] = errors.get(kind, 0) + 1

  def exception(self, error: BaseException, path=None, **context):
    """Records an error from an exception, e.g. when deleting a folder failed"""
    path = failed_path(error, path)
    self.error(error_kind(error), str(error), path=path, owner=owner(path), **context)

  def error_message(self, message: str, **context):
    """Records an error that we only have as text, e.g. from CiCommit.delete"""
    self.exception(Exception(message), **context)

  def should_stop(self) -> bool:
    return False

  def flush(self, force=False):
    pass


class ConsoleReporter(Reporter):
  """For the command line: what qaboard_clean always printed"""
  colors = {'info': None, 'debug': None, 'warning': 'yellow', 'error': 'red', 'success': 'green', 'title': 'blue'}

  def log(self, message: str, level: str = 'info'):
    click.secho(message, fg=self.colors.get(level), bold=level == 'title', dim=level == 'debug')

  def error(self, kind, message, path=None, project_id=None, batch_id=None, output_id=None, owner=None):
    super().error(kind, message, path=path)
    click.secho(f"  ERROR ({kind}{f', owned by {owner}' if owner else ''}): {message}", fg='red')


class DatabaseReporter(Reporter):
  """
  Saves a job's progress, logs and errors in the database, at most every few seconds.
  It uses its own connections: what the job does in its session can be rolled back, what it reported stays.
  """
  def __init__(self, job_id: int, stopping=lambda: False, echo=True):
    super().__init__()
    from ..database import engine
    from ..models import Job
    self.engine = engine
    self.job_id = job_id
    self.stopping = stopping  # e.g. the worker is shutting down
    self.echo = echo
    self.lines = []
    self.errors = []
    self.saved_errors = 0
    self.cancelled = False
    self.flushed_at = None
    with engine.begin() as connection:
      row = connection.execute(Job.__table__.select().where(Job.__table__.c.id == job_id)).mappings().one()
    # a job that runs again (its worker stopped) keeps counting
    self.progress = dict(row['progress'] or {})
    self.nb_errors = sum((self.progress.get('errors') or {}).values())
    self.log_lines = list(row['log'] or [])
    with engine.begin() as connection:
      self.saved_errors = connection.execute(
        text("SELECT count(*) FROM (SELECT 1 FROM job_errors WHERE job_id = :job_id LIMIT :max) e"),
        {"job_id": job_id, "max": MAX_ERRORS},
      ).scalar()

  def log(self, message: str, level: str = 'info'):
    if self.echo:
      print(f"[job {self.job_id}] {message}", flush=True)
    self.lines.append({"at": utcnow().isoformat() + 'Z', "level": level, "message": message[:2000]})
    self.flush()

  def error(self, kind, message, path=None, project_id=None, batch_id=None, output_id=None, owner=None):
    super().error(kind, message)
    if self.saved_errors + len(self.errors) < MAX_ERRORS:
      self.errors.append({
        "job_id": self.job_id, "created_at": utcnow(), "kind": kind, "message": message[:5000],
        "project_id": project_id, "batch_id": batch_id, "output_id": output_id,
        "path": str(path) if path else None, "owner": owner,
      })
    else:
      self.progress['errors_not_saved'] = self.progress.get('errors_not_saved', 0) + 1
    # the first errors are in the log too: they show what's going on
    if self.nb_errors <= 20:
      self.log(f"{kind} error{f' ({owner})' if owner else ''}: {message}", level='error')
    elif self.nb_errors == 21:
      self.log("More errors: see the job's errors", level='error')
    self.flush()

  def should_stop(self) -> bool:
    self.flush()
    return self.cancelled or self.stopping()

  def flush(self, force=False):
    now = utcnow()
    if not force and self.flushed_at and (now - self.flushed_at).total_seconds() < FLUSH_EVERY:
      return
    self.flushed_at = now
    from ..models import Job, JobError
    jobs = Job.__table__
    log_lines = (self.log_lines + self.lines)[-LOG_LINES:]
    try:
      with self.engine.begin() as connection:
        if self.errors:
          connection.execute(JobError.__table__.insert(), self.errors)
        cancelled = connection.execute(
          jobs.update().where(jobs.c.id == self.job_id)
          .values(progress=self.progress, log=log_lines, heartbeat_at=now)
          .returning(jobs.c.cancel_requested)
        ).scalar()
      self.saved_errors += len(self.errors)
      self.log_lines, self.errors, self.lines = log_lines, [], []
      self.cancelled = bool(cancelled)
    except Exception:
      # e.g. the database restarts: we'll try again with the next flush
      print(f"[job {self.job_id}] WARNING: could not save the progress: {traceback.format_exc()}", flush=True)
