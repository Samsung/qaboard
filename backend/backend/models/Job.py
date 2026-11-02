"""
Server jobs: long maintenance tasks started by admins or by schedules, e.g. hard-deleting the runs users deleted.
The database is the queue: workers (`qaboard-admin jobs worker`) claim queued jobs, and save their progress,
logs and errors here, so the web app can show them. See backend/jobs/.
"""
import datetime

from sqlalchemy import Column, BigInteger, Integer, String, Text, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class Job(Base):
  __tablename__ = 'jobs'

  id = Column(BigInteger, primary_key=True)
  # what it does, see backend/jobs/kinds.py: hard_delete, garbage_collect
  kind = Column(String(), nullable=False)
  # what admins asked for, validated by the job's kind (e.g. projects, dates, dry_run)
  params = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # queued, running, done, done_with_errors, failed (crashed), cancelled
  status = Column(String(), nullable=False, default='queued', server_default='queued')
  # counters, e.g. {"runs_deleted": 10, "errors": {"permission": 2}}
  progress = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # the latest lines of the job's log: [{"at", "level", "message"}]
  log = Column(JSONB(), nullable=False, default=list, server_default='[]')
  # why it failed, when it crashed
  error = Column(Text(), nullable=True)

  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # who asked: an admin, or a schedule (created_by_label is the schedule's name)
  created_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  created_by_label = Column(String(), nullable=True)
  schedule_id = Column(Integer, ForeignKey('job_schedules.id', ondelete='SET NULL'), nullable=True)

  started_at = Column(DateTime, nullable=True)
  finished_at = Column(DateTime, nullable=True)
  # running jobs whose worker stopped sending heartbeats are queued again
  heartbeat_at = Column(DateTime, nullable=True)
  worker = Column(String(), nullable=True)
  attempts = Column(Integer, nullable=False, default=0, server_default='0')
  cancel_requested = Column(Boolean, nullable=False, default=False, server_default='false')

  __table_args__ = (
    Index('ix_jobs_status', 'status'),
    Index('ix_jobs_schedule_id', 'schedule_id'),
  )


class JobError(Base):
  """What a job could not do, e.g. a folder it could not delete: one row each, so admins can see and fix them all."""
  __tablename__ = 'job_errors'

  id = Column(BigInteger, primary_key=True)
  job_id = Column(BigInteger, ForeignKey('jobs.id', ondelete='CASCADE'), nullable=False)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # permission, unsafe_path, git, database, other
  kind = Column(String(), nullable=False)
  message = Column(Text(), nullable=False)
  project_id = Column(String(), nullable=True)
  batch_id = Column(Integer, nullable=True)
  output_id = Column(Integer, nullable=True)
  path = Column(Text(), nullable=True)
  # who owns the file that could not be deleted: who can fix it
  owner = Column(String(), nullable=True)

  __table_args__ = (
    Index('ix_job_errors_job_id_kind', 'job_id', 'kind'),
  )


class JobSchedule(Base):
  """Jobs started on a schedule, like cron jobs, e.g. every night: hard-delete the runs deleted over a month ago."""
  __tablename__ = 'job_schedules'

  id = Column(Integer, primary_key=True)
  name = Column(String(), nullable=False)
  kind = Column(String(), nullable=False)
  params = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # 5 fields: minute hour day-of-month month day-of-week, e.g. "0 2 * * *", in `timezone`
  cron = Column(String(), nullable=False)
  timezone = Column(String(), nullable=False, default='UTC', server_default='UTC')
  enabled = Column(Boolean, nullable=False, default=True, server_default='true')
  # in UTC, computed from cron when it's saved and after each run
  next_run_at = Column(DateTime, nullable=True)
  last_run_at = Column(DateTime, nullable=True)
  last_job_id = Column(BigInteger, nullable=True)
  # e.g. "skipped: the previous run was still running"
  last_message = Column(Text(), nullable=True)

  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
  updated_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)


class JobWorker(Base):
  """Workers say they're alive, so admins know jobs will run"""
  __tablename__ = 'job_workers'

  id = Column(String(), primary_key=True)  # hostname:pid
  started_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  seen_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  job_id = Column(BigInteger, nullable=True)
  version = Column(String(), nullable=True)
