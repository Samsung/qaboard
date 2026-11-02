"""
The jobs queue, in the database: admins and schedules add jobs, workers claim them.
Nothing here depends on the web framework or on a task queue: the API (api/admin_jobs.py), the CLI
(`qaboard-admin jobs`) and the worker (backend/jobs/worker.py) call these functions.
"""
import datetime
import traceback
from typing import Optional

from ..database import db_session
from ..models import Job, JobError, JobSchedule, JobWorker
from . import kinds, alerts
from .cron import next_run, Cron, CronError, timezone
from .params import ParamsError
from .report import DatabaseReporter, utcnow


ACTIVE = ('queued', 'running')
FINISHED = ('done', 'done_with_errors', 'failed', 'cancelled')
# a running job whose worker didn't send a heartbeat for that long is queued again (the worker was killed)
STALE_AFTER = datetime.timedelta(minutes=10)
MAX_ATTEMPTS = 5
# errors of old jobs are deleted, their counters stay
KEEP_ERRORS = datetime.timedelta(days=90)


class Busy(Exception):
  """A job of the same kind is already queued or running"""
  def __init__(self, job):
    self.job = job
    super().__init__(f"Job #{job.id} ({kinds.LABELS.get(job.kind, job.kind)}) is already {job.status}: wait for it to finish, or cancel it.")


def active_job(kind: str) -> Optional[Job]:
  return Job.query.filter(Job.kind == kind, Job.status.in_(ACTIVE)).order_by(Job.id).first()


def create(kind: str, params: dict, user=None, label: Optional[str] = None, schedule: Optional[JobSchedule] = None) -> Job:
  """Queues a job. Raises ParamsError if the parameters are invalid, Busy if a job of the kind is active. The caller commits."""
  params = kinds.validate(kind, params)
  # Jobs of the same kind would do the same work twice, and fight over the same files
  busy = None if getattr(kinds.get(kind), 'CONCURRENT', False) else active_job(kind)
  if busy:
    raise Busy(busy)
  job = Job(
    kind=kind,
    params=params,
    status='queued',
    created_by_id=user.id if user is not None else None,
    created_by_label=label or (user.user_name if user is not None else None),
    schedule_id=schedule.id if schedule is not None else None,
    created_at=utcnow(),
  )
  db_session.add(job)
  db_session.flush()
  return job


def cancel(job: Job, force=False) -> Job:
  """
  Queued jobs stop now, running jobs at their next check (seconds). The caller commits.
  `force`: a running job is cancelled now, without waiting for its worker, e.g. stuck on a storage that doesn't answer,
  or whose worker is gone. Another job of its kind can start, its worker still finishes what it was doing.
  """
  if job.status == 'queued':
    job.status = 'cancelled'
    job.finished_at = utcnow()
  elif job.status == 'running':
    job.cancel_requested = True
    if force:
      now = utcnow()
      job.status, job.finished_at = 'cancelled', now
      job.log = [*(job.log or []), {"at": now.isoformat() + 'Z', "level": 'warning',
                 "message": f"Cancelled without waiting for its worker{f' ({job.worker})' if job.worker else ''}: it may still be busy with it"}][-300:]
  return job


def requeue_stale(now=None) -> int:
  """Jobs whose worker died (killed, host reboot...) are queued again: they resume where they were."""
  now = now or utcnow()
  stale = (Job.query.filter(Job.status == 'running', Job.heartbeat_at < now - STALE_AFTER)
           .with_for_update(skip_locked=True).all())
  given_up = []
  for job in stale:
    message = f"The worker {job.worker} stopped responding"
    if job.cancel_requested:
      job.status, job.finished_at = 'cancelled', now
    elif job.attempts >= MAX_ATTEMPTS:
      job.status, job.finished_at, job.error = 'failed', now, f"{message}, {job.attempts} times: giving up."
      given_up.append(job)
    else:
      job.status, job.worker = 'queued', None
    job.log = [*(job.log or []), {"at": now.isoformat() + 'Z', "level": 'warning', "message": f"{message}: {'queued again, it will resume' if job.status == 'queued' else 'cancelled' if job.status == 'cancelled' else 'giving up'}"}][-300:]
  db_session.commit()
  for job in given_up:
    alerts.job_went_wrong(job, 'failed', message=job.error)
  return len(stale)


def claim(worker_id: str, interactive: Optional[bool] = None) -> Optional[int]:
  """The next queued job, now running on this worker. `interactive`: only those kinds (True), or only the others (False)"""
  query = Job.query.filter(Job.status == 'queued')
  if interactive is True:
    query = query.filter(Job.kind.in_(kinds.INTERACTIVE))
  elif interactive is False:
    query = query.filter(Job.kind.notin_(kinds.INTERACTIVE))
  job = query.order_by(Job.id).with_for_update(skip_locked=True).first()
  if job is None:
    db_session.commit()
    return None
  now = utcnow()
  job.status, job.worker, job.heartbeat_at = 'running', worker_id, now
  job.started_at = job.started_at or now
  job.attempts = (job.attempts or 0) + 1
  job.cancel_requested = bool(job.cancel_requested)
  db_session.commit()
  return job.id


def run(job_id: int, stopping=lambda: False, echo=True) -> str:
  """Runs a claimed job. Returns its new status. Never raises: what went wrong is saved with the job."""
  job = db_session.get(Job, job_id)
  kind, params = job.kind, dict(job.params or {})
  db_session.commit()
  report = DatabaseReporter(job_id, stopping=stopping, echo=echo)
  error, exception = None, None
  try:
    module = kinds.get(kind)
    params = module.validate(params)
    report.log(f"{'Resuming' if report.progress else 'Starting'}: {module.describe(params)}{' (dry run)' if params.get('dry_run') else ''}")
    module.run(params, report)
  except Exception as e:
    db_session.rollback()
    error, exception = traceback.format_exc(), e
    report.log(f"The job crashed: {error.strip().splitlines()[-1]}", level='error')
  report.flush(force=True)

  job = db_session.get(Job, job_id)
  db_session.refresh(job)
  if job.status == 'cancelled':
    # an admin didn't wait for it (cancel(force=True)): it's over already
    job.log = [*(job.log or []), {"at": utcnow().isoformat() + 'Z', "level": 'info', "message": "Its worker stopped too"}][-300:]
    db_session.commit()
    return 'cancelled'
  if error:
    status = 'failed'
  elif report.cancelled or job.cancel_requested:
    status = 'cancelled'
  elif stopping():
    # the worker is shutting down (e.g. a deploy): another worker resumes it
    status = 'queued'
  else:
    status = 'done_with_errors' if report.nb_errors else 'done'
  job.status, job.error = status, error
  if status == 'queued':
    job.worker = None
    job.log = [*(job.log or []), {"at": utcnow().isoformat() + 'Z', "level": 'warning', "message": "The worker is stopping: queued again, it will resume"}][-300:]
  else:
    job.finished_at = utcnow()
    job.log = [*(job.log or []), {"at": utcnow().isoformat() + 'Z', "level": 'error' if status == 'failed' else 'success' if status == 'done' else 'warning',
               "message": {"failed": "Failed", "cancelled": "Cancelled", "done": "Done", "done_with_errors": f"Done, with {report.nb_errors} errors"}[status]}][-300:]
  db_session.commit()
  if status in ('failed', 'done_with_errors'):
    alerts.job_went_wrong(job, status, error=exception)
  return status


def validate_schedule(fields: dict) -> dict:
  """name, kind, params, cron, timezone, enabled => the valid columns, or raises ParamsError"""
  valid = {}
  if 'name' in fields:
    name = fields['name']
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
      raise ParamsError("`name` is required (at most 200 characters)")
    valid['name'] = name.strip()
  if 'kind' in fields:
    kinds.get(fields['kind'])
    valid['kind'] = fields['kind']
  if 'cron' in fields:
    try:
      Cron(fields['cron'])
    except CronError as e:
      raise ParamsError(f"`cron`: {e}")
    valid['cron'] = fields['cron'].strip()
  if 'timezone' in fields:
    try:
      timezone(fields['timezone'])
    except CronError as e:
      raise ParamsError(str(e))
    valid['timezone'] = fields['timezone'] or 'UTC'
  if 'enabled' in fields:
    if not isinstance(fields['enabled'], bool):
      raise ParamsError("`enabled` must be true or false")
    valid['enabled'] = fields['enabled']
  return valid


def save_schedule(schedule: JobSchedule, fields: dict, user=None) -> JobSchedule:
  """Creates or updates a schedule. Raises ParamsError. The caller commits."""
  valid = validate_schedule(fields)
  kind = valid.get('kind', schedule.kind)
  if 'params' in fields or schedule.id is None:
    valid['params'] = kinds.validate(kind, fields.get('params'))
  elif 'kind' in valid:
    valid['params'] = kinds.validate(kind, schedule.params)
  for key, value in valid.items():
    setattr(schedule, key, value)
  schedule.timezone = schedule.timezone or 'UTC'
  if schedule.enabled is None:
    schedule.enabled = True
  if user is not None:
    schedule.updated_by_id = user.id
  schedule.next_run_at = next_run(schedule.cron, schedule.timezone, utcnow()) if schedule.enabled else None
  db_session.add(schedule)
  db_session.flush()
  return schedule


def run_schedule(schedule: JobSchedule, now=None, user=None) -> Optional[Job]:
  """Queues the schedule's job, now. Returns None if one of the kind was already running: we say why on the schedule."""
  now = now or utcnow()
  schedule.last_run_at = now
  try:
    job = create(schedule.kind, schedule.params, user=user, label=user.user_name if user else f"schedule: {schedule.name}", schedule=schedule)
  except (Busy, ParamsError) as e:
    schedule.last_message = f"Skipped: {e}"
    return None
  schedule.last_job_id = job.id
  schedule.last_message = None
  return job


def run_due_schedules(now=None) -> int:
  """Queues the jobs of the schedules that are due. Safe with several workers: each schedule is taken by one."""
  now = now or utcnow()
  due = (JobSchedule.query.filter(JobSchedule.enabled.is_(True), JobSchedule.next_run_at <= now)
         .order_by(JobSchedule.next_run_at).with_for_update(skip_locked=True).all())
  for schedule in due:
    run_schedule(schedule, now)
    try:
      schedule.next_run_at = next_run(schedule.cron, schedule.timezone, now)
    except CronError as e:
      schedule.enabled, schedule.next_run_at, schedule.last_message = False, None, f"Disabled: {e}"
  db_session.commit()
  return len(due)


def purge_old_errors(now=None) -> int:
  now = now or utcnow()
  old_jobs = db_session.query(Job.id).filter(Job.status.in_(FINISHED), Job.finished_at < now - KEEP_ERRORS)
  count = JobError.query.filter(JobError.job_id.in_(old_jobs.scalar_subquery())).delete(synchronize_session=False)
  db_session.commit()
  return count


# --- what we answer ---

def iso(date):
  return f"{date.isoformat()}Z" if date else None


def serialize_job(job: Job, with_log=False) -> dict:
  params = job.params or {}
  module = kinds.KINDS.get(job.kind)
  try:
    description = module.describe(module.validate(params)) if module else job.kind
  except Exception:
    description = job.kind
  answer = {
    "id": job.id,
    "kind": job.kind,
    "kind_label": kinds.LABELS.get(job.kind, job.kind),
    "description": description,
    "params": params,
    "dry_run": bool(params.get('dry_run')),
    "status": job.status,
    "cancel_requested": bool(job.cancel_requested),
    # without what they need to resume
    "progress": {k: v for k, v in (job.progress or {}).items() if k not in ('projects_finished', 'resume')},
    "error": job.error,
    "created_at": iso(job.created_at),
    "created_by": job.created_by_label,
    "schedule_id": job.schedule_id,
    "started_at": iso(job.started_at),
    "finished_at": iso(job.finished_at),
    "heartbeat_at": iso(job.heartbeat_at),
    "worker": job.worker,
    "attempts": job.attempts,
  }
  if with_log:
    answer["log"] = job.log or []
  return answer


def serialize_error(error: JobError) -> dict:
  return {
    "id": error.id,
    "created_at": iso(error.created_at),
    "kind": error.kind,
    "message": error.message,
    "project_id": error.project_id,
    "batch_id": error.batch_id,
    "output_id": error.output_id,
    "path": error.path,
    "owner": error.owner,
  }


def serialize_schedule(schedule: JobSchedule) -> dict:
  module = kinds.KINDS.get(schedule.kind)
  try:
    description = module.describe(module.validate(schedule.params or {}))
  except Exception:
    description = schedule.kind
  return {
    "id": schedule.id,
    "name": schedule.name,
    "kind": schedule.kind,
    "kind_label": kinds.LABELS.get(schedule.kind, schedule.kind),
    "description": description,
    "params": schedule.params or {},
    "cron": schedule.cron,
    "timezone": schedule.timezone,
    "enabled": schedule.enabled,
    "next_run_at": iso(schedule.next_run_at),
    "last_run_at": iso(schedule.last_run_at),
    "last_job_id": schedule.last_job_id,
    "last_message": schedule.last_message,
    "updated_at": iso(schedule.updated_at),
  }


WORKER_ONLINE = datetime.timedelta(minutes=2)


def workers() -> dict:
  """Who runs jobs: admins must know if nobody does"""
  now = utcnow()
  rows = JobWorker.query.filter(JobWorker.seen_at > now - datetime.timedelta(days=1)).order_by(JobWorker.seen_at.desc()).all()
  return {
    "online": [{"id": w.id, "started_at": iso(w.started_at), "seen_at": iso(w.seen_at), "job_id": w.job_id, "version": w.version}
               for w in rows if w.seen_at > now - WORKER_ONLINE],
    "last_seen_at": iso(rows[0].seen_at) if rows else None,
  }
