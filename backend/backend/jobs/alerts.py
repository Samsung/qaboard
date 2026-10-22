"""
Telling admins when jobs go wrong, without them watching Admin > Storage:
- Sentry (if $SENTRY_DSN is set) gets an issue when a job crashes, ends with errors, or a worker gives up on it,
  and for the worker's own crashes (e.g. it can't start the schedules). Jobs record most errors and carry on:
  those are reported too, one issue per kind of job.
- The schedules' jobs that fail or end with errors are emailed to admins (settings jobs.failure_emails and
  jobs.failure_email_to), with what went wrong and a link to the job. Jobs that admins start themselves aren't:
  they watch them.

Alerts never get in the way of the jobs: what goes wrong while sending them is only printed.
"""
import html
import time
import traceback
from typing import Optional


# the worker retries every few seconds: e.g. while the database restarts, one event per error and quarter of an hour is enough
THROTTLE_SECONDS = 900
_reported_at = {}


def _sentry():
  try:
    import sentry_sdk
  except ImportError:
    return None
  return sentry_sdk if sentry_sdk.is_initialized() else None


def capture_exception(error: Optional[BaseException] = None, **tags):
  """For the worker's own errors, that it survives: e.g. the database restarts"""
  sentry_sdk = _sentry()
  if sentry_sdk is None:
    return
  key = (type(error).__name__, str(error)[:200])
  now = time.monotonic()
  if now - _reported_at.get(key, -THROTTLE_SECONDS) < THROTTLE_SECONDS:
    return
  _reported_at[key] = now
  try:
    with sentry_sdk.new_scope() as scope:
      for key, value in tags.items():
        scope.set_tag(key, value)
      sentry_sdk.capture_exception(error)
  except Exception:
    print(f"WARNING: could not report to Sentry: {traceback.format_exc()}", flush=True)


def report_to_sentry(job, status: str, error: Optional[BaseException] = None, message: Optional[str] = None, schedule=None):
  """A job that crashed (`error`), ended with errors, or was given up (`message`)"""
  sentry_sdk = _sentry()
  if sentry_sdk is None:
    return
  from . import kinds
  try:
    with sentry_sdk.new_scope() as scope:
      scope.set_tag('job.kind', job.kind)
      scope.set_tag('job.status', status)
      scope.set_tag('job.scheduled', job.schedule_id is not None)
      scope.set_context('job', {
        "id": job.id,
        "kind": job.kind,
        "status": status,
        "schedule": schedule.name if schedule is not None else None,
        "worker": job.worker,
        "attempts": job.attempts,
        "params": job.params,
        "progress": {k: v for k, v in (job.progress or {}).items() if k not in ('projects_finished', 'resume')},
      })
      if error is not None:
        # grouped by the code that raised, like other exceptions
        sentry_sdk.capture_exception(error)
      else:
        # one issue per kind of job: its occurrences are the runs that went wrong
        scope.fingerprint = ['qaboard-job', job.kind, status]
        label = kinds.LABELS.get(job.kind, job.kind)
        sentry_sdk.capture_message(message or f"Job \"{label}\": {status}", level='error' if status == 'failed' else 'warning')
  except Exception:
    print(f"WARNING: could not report job {job.id} to Sentry: {traceback.format_exc()}", flush=True)


def recipients() -> list:
  """Who gets the emails: jobs.failure_email_to, else the active admins we know the email of"""
  from ..settings import setting
  from ..notifications.mail import recipient_for, email_settings
  settings = email_settings()
  names = setting('jobs.failure_email_to') or []
  if not names:
    from ..admins import env_admins
    from ..models import User
    admins = User.query.filter(User.is_admin.is_(True), User.status == 'active').all()
    names = [*env_admins(), *(u.email or u.user_name for u in admins)]
  found = []
  for name in names:
    recipient = recipient_for(None, name, settings) if '@' in name else recipient_for(name, None, settings)
    if recipient and recipient.lower() not in {f.lower() for f in found}:
      found.append(recipient)
  return found


def email_content(job, status: str, schedule=None, error_summary: Optional[str] = None, errors=()) -> dict:
  """subject, text and html of the email about a job that went wrong. `errors`: some of the errors it recorded"""
  from ..config import qaboard_url
  from . import kinds
  label = kinds.LABELS.get(job.kind, job.kind)
  name = schedule.name if schedule is not None else label
  what = {
    'failed': "failed",
    'done_with_errors': f"ended with {sum(((job.progress or {}).get('errors') or {}).values())} errors",
  }.get(status, status)
  link = f"{qaboard_url.rstrip('/')}/admin/storage/jobs/{job.id}"
  lines = [
    f"The scheduled job \"{name}\" ({label}, job #{job.id}) {what}.",
    "",
  ]
  if error_summary:
    lines += ["What went wrong:", error_summary.strip(), ""]
  counters = (job.progress or {}).get('errors') or {}
  if counters:
    lines += ["Errors: " + ", ".join(f"{count} {kind}" for kind, count in sorted(counters.items())), ""]
  if errors:
    lines += ["The first errors:", *(f"- [{e.kind}]{f' ({e.owner})' if e.owner else ''} {e.message}" for e in errors), ""]
  lines += [f"Details, logs and all the errors: {link}"]
  if schedule is not None:
    lines += [f"The schedules: {qaboard_url.rstrip('/')}/admin/storage"]
  text = "\n".join(lines)
  body = "".join(f"<p style=\"white-space: pre-wrap\">{html.escape(paragraph)}</p>" for paragraph in text.split("\n\n"))
  return {
    "subject": f"[QA-Board] Scheduled job {what}: {name}",
    "text": text,
    "html": f"<div style=\"font-family: sans-serif\">{body}</div>",
  }


def email_admins(job, status: str, schedule=None, error_summary: Optional[str] = None):
  from ..settings import setting
  from ..notifications.mail import email_settings, send_email
  from ..models import JobError
  if job.schedule_id is None or not setting('jobs.failure_emails'):
    return
  settings = email_settings()
  if not settings.enabled:
    return
  to = recipients()
  if not to:
    print(f"WARNING: nobody to email about job {job.id}: set jobs.failure_email_to, or the admins' emails", flush=True)
    return
  errors = JobError.query.filter(JobError.job_id == job.id).order_by(JobError.id).limit(10).all()
  content = email_content(job, status, schedule=schedule, error_summary=error_summary, errors=errors)
  send_email(", ".join(to), content['subject'], content['html'], content['text'],
             headers={'X-QABoard-Job': job.kind}, settings=settings)


def job_went_wrong(job, status: str, error: Optional[BaseException] = None, message: Optional[str] = None):
  """
  Called when a job failed (`error`: what it raised), ended with errors, or was given up (`message`).
  Never raises.
  """
  from ..database import db_session
  from ..models import JobSchedule
  try:
    schedule = db_session.get(JobSchedule, job.schedule_id) if job.schedule_id is not None else None
  except Exception:
    db_session.rollback()
    schedule = None
  report_to_sentry(job, status, error=error, message=message, schedule=schedule)
  summary = message
  if error is not None:
    # the end of the traceback says where and why
    summary = "".join(traceback.format_exception(error)[-6:])
  try:
    email_admins(job, status, schedule=schedule, error_summary=summary)
  except Exception as e:
    db_session.rollback()
    print(f"WARNING: could not email the admins about job {job.id}: {type(e).__name__}: {e}", flush=True)
    capture_exception(e, **{'job.kind': job.kind})
