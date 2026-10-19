"""
Notify users when the batches they started end: requests, knowing when it's over, sending.

How we know a batch is over, cheaply even for batches with thousands of runs:
- `qa batch` tells QA-Board about all its runs (as pending) before it starts any of them.
- Runs remember the command that started them, in Output.data.root_command_id (nested `qa batch`
  commands, e.g. pipeline steps, pass on the first command's id: one email for the whole pipeline).
- When a run ends, we look for a notification waiting for its command (a lookup by a unique key, usually
  there is none). If there is one, we check whether the command has pending runs left, with an index of
  the pending runs only. When none are left, we claim the notification and send it, exactly once.
"""
import os
import datetime
from urllib.parse import urljoin

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from backend.config import qaboard_url
from backend.models import BatchNotification, Output, Batch
from .mail import email_settings, recipient_for, send_email
from .batch_email import render_batch_email, summarize, tuning_params


def shorten(value, max_length) -> str:
  """Keeps the end of paths, the most specific part"""
  value = str(value or '')
  return value if len(value) <= max_length else '…' + value[-(max_length - 1):]


def truncate(value, max_length) -> str:
  return value if len(value) <= max_length else value[:max_length - 1] + '…'


def request_batch_notification(session, command_id, ci_commit, batch, user_name, email=None, data=None):
  """
  Asks to email `user_name` when the runs of `qa batch` command `command_id` end.
  Returns (notification, None), or (None, why we can't).
  """
  settings = email_settings()
  if not settings.enabled:
    return None, "This QA-Board server can't send emails. Ask its administrators to configure it (QABOARD_SMTP_HOST)."
  recipient = recipient_for(user_name, email, settings)
  if not recipient:
    return None, f"QA-Board doesn't know the email address of {user_name}."
  existing = session.query(BatchNotification).filter(BatchNotification.command_id == command_id).one_or_none()
  if existing:
    return existing, None
  notification = BatchNotification(
    command_id=command_id,
    channel='email',
    user_name=user_name,
    recipient=recipient,
    ci_commit_id=ci_commit.id,
    batch_id=batch.id if batch is not None else None,
    status='waiting',
    data=data or {},
  )
  session.add(notification)
  try:
    session.commit()
  except IntegrityError:
    # requested at the same time by another request for the same command
    session.rollback()
    return session.query(BatchNotification).filter(BatchNotification.command_id == command_id).one_or_none(), None
  return notification, None


def cancel_batch_notification(session, command_id, reason):
  session.query(BatchNotification).filter(
    BatchNotification.command_id == command_id,
    BatchNotification.status == 'waiting',
  ).update({'status': 'cancelled', 'error': reason}, synchronize_session=False)
  session.commit()


# Uses idx_outputs_pending_root_command: it indexes only the pending runs
has_pending_runs = text("SELECT 1 FROM outputs WHERE is_pending AND (data->>'root_command_id') = :command_id LIMIT 1")


def on_run_ended(session, root_command_id):
  """Called when a run's ends. Sends the notification of the command that started it, if this was its last run."""
  if not root_command_id:
    return
  try:
    notification_id = (session
      .query(BatchNotification.id)
      .filter(BatchNotification.command_id == root_command_id, BatchNotification.status == 'waiting')
      .scalar()
    )
    if notification_id is None:
      return
    if session.execute(has_pending_runs, {"command_id": root_command_id}).first():
      return
    # Runs that end at the same time all see that none are left: only one claims the notification
    claimed = (session
      .query(BatchNotification)
      .filter(BatchNotification.id == notification_id, BatchNotification.status == 'waiting')
      .update({'status': 'sending', 'finished_at': datetime.datetime.utcnow()}, synchronize_session=False)
    )
    session.commit()
    if claimed:
      send_batch_notification(session, session.get(BatchNotification, notification_id))
  except Exception as e:
    # Notifications never get in the way of saving results
    print(f"WARNING: could not notify about the end of command {root_command_id}: {type(e).__name__}: {e}")
    session.rollback()


def command_runs(session, notification):
  """The runs of the notification's command, in all the batches of its commit"""
  rows = (session
    .query(Output, Batch.label)
    .join(Batch, Output.batch_id == Batch.id)
    .filter(Batch.ci_commit_id == notification.ci_commit_id)
    .filter(Output.deleted.isnot(True))
    .filter(text("(outputs.data->>'root_command_id') = :command_id"))
    .params(command_id=notification.command_id)
    .all()
  )
  return [{
    'id': output.id,
    'input': shorten(output.test_input.path if output.test_input else None, 72),
    'platform': output.platform,
    'batch': label,
    'params': tuning_params(output.extra_parameters),
    'is_failed': bool(output.is_failed),
    'metrics': output.metrics if isinstance(output.metrics, dict) else {},
  } for output, label in rows]


def docs_url(page):
  docs_root = os.environ.get('QABOARD_DOCS_ROOT', '/')
  return urljoin(urljoin(qaboard_url.rstrip('/') + '/', docs_root.lstrip('/') if not docs_root.startswith('http') else docs_root), page)


def format_time(date):
  """In QABOARD_EMAIL_TIMEZONE (e.g. Asia/Jerusalem), else UTC"""
  import pytz
  name = os.environ.get('QABOARD_EMAIL_TIMEZONE') or 'UTC'
  try:
    timezone = pytz.timezone(name)
  except pytz.UnknownTimeZoneError:
    timezone = pytz.utc
  local = pytz.utc.localize(date).astimezone(timezone)
  return local.strftime('%a %d %b, %H:%M ') + (local.tzname() or name)


def send_batch_notification(session, notification):
  """Sends the email of a notification that is `sending`, and records the outcome."""
  try:
    ci_commit = notification.ci_commit
    project = ci_commit.project
    batch = notification.batch
    data = notification.data or {}
    label = batch.label if batch is not None else data.get('label', 'default')
    metrics_config = ((batch.data or {}).get('qatools_metrics') if batch is not None else None) \
                     or (ci_commit.data or {}).get('qatools_metrics') \
                     or (project.data or {}).get('qatools_metrics')
    runs = command_runs(session, notification)
    summary = summarize(runs, metrics_config)
    finished_at = notification.finished_at or datetime.datetime.utcnow()
    message = (ci_commit.message or '').strip().splitlines() if ci_commit.message != '<NA>' else []
    subject, html, text_content = render_batch_email(summary, {
      'qaboard_url': qaboard_url,
      'project_id': ci_commit.project_id,
      'project_name': ci_commit.project_id,
      'hexsha': ci_commit.hexsha,
      'branch': (ci_commit.branch or '').replace('origin/', '') or None,
      'commit_message': truncate(message[0], 72) if message else None,
      'label': label,
      'selected_group': data.get('selected_group'),
      'platform': data.get('platform'),
      'source': data.get('source'),
      'user_name': notification.user_name,
      'duration_s': (finished_at - notification.created_date).total_seconds(),
      'started_at': format_time(notification.created_date),
      'docs_url': docs_url('docs/user-guide/running-from-the-webapp#emails-when-batches-end'),
    })
    send_email(notification.recipient, subject, html, text_content, headers={
      'X-QABoard-Project': ci_commit.project_id,
      'X-QABoard-Batch': label,
      'X-QABoard-Status': 'failed' if summary['failed'] else 'succeeded',
    })
    notification.status = 'sent'
    notification.sent_at = datetime.datetime.utcnow()
    notification.data = {**data, 'runs': summary['total'], 'failed': summary['failed']}
    print(f"Emailed {notification.recipient}: {subject}")
  except Exception as e:
    print(f"WARNING: could not send {notification}: {type(e).__name__}: {e}")
    session.rollback()
    notification.status = 'failed'
    notification.error = f"{type(e).__name__}: {e}"
  session.add(notification)
  session.commit()
