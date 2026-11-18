"""
Runs that stopped reporting, e.g. their machine was killed or lost the network: we mark them failed instead of
leaving them "running" forever.

- Clients that send heartbeats say so when the run starts (`heartbeat: true`, kept as data.heartbeat): `qa run`
  and qaboard.start_run() report at least every HEARTBEAT_INTERVAL while the run goes on (PATCH .../progress).
  Runs from older clients never say it: they are never failed for being silent.
- Each report about a running run sets outputs.reported_at (POST /api/v1/output/, PATCH .../progress).
- The jobs worker calls fail_silent_runs() (backend/jobs/worker.py): the runs silent for longer than
  $QABOARD_SILENT_RUN_TIMEOUT_MINUTES are failed, with data.silent_since saying when we last heard from them.
- A failed silent run that reports again is running again: what runs tell us is their state, not events.
"""
import datetime
from typing import Optional

from sqlalchemy.orm.attributes import flag_modified

from . import config


def iso_utc(date) -> str:
  return f"{date.isoformat()}Z"


def reported(output, now: Optional[datetime.datetime] = None) -> None:
  """A running run told us something. Revives a run we failed because it was silent."""
  now = now or datetime.datetime.utcnow()
  data = output.data or {}
  if 'silent_since' in data:
    output.data = {k: v for k, v in data.items() if k not in ('silent_since', 'failed_reason')}
    flag_modified(output, 'data')
    output.is_failed = False
    output.set_status(True, True, now=now)
  output.reported_at = now


def fail_silent_runs(now: Optional[datetime.datetime] = None) -> int:
  """Fails the running runs that send heartbeats and stayed silent too long. Returns how many."""
  from backend import db_session
  from .models import Output
  if not config.silent_run_timeout_minutes:
    return 0
  now = now or datetime.datetime.utcnow()
  limit = now - datetime.timedelta(minutes=config.silent_run_timeout_minutes)
  silent = (Output.query
    .filter(Output.is_pending.is_(True), Output.is_running.is_(True), Output.reported_at < limit)
    .with_for_update(skip_locked=True).all())
  count = 0
  for output in silent:
    if not (output.data or {}).get('heartbeat'):
      continue
    # like the runs "Fail stuck runs" fails (backend/run_activity.py:fail_runs), shown in Runs activity
    reason = f"Stopped reporting at {output.reported_at.strftime('%Y-%m-%d %H:%M')} UTC, e.g. its machine was killed or lost the network: marked as failed after {config.silent_run_timeout_minutes:g} minutes."
    output.data = {**(output.data or {}), 'silent_since': iso_utc(output.reported_at), 'failed_reason': reason}
    flag_modified(output, 'data')
    output.is_failed = True
    output.set_status(False, False, now=now)
    count += 1
  db_session.commit()
  # like for stuck runs: no "batch ended" email for batches whose runs we failed, but one saying why
  from .run_activity import cancel_notifications
  failed = [output for output in silent if 'silent_since' in (output.data or {})]
  for command_id in sorted({output.data.get('root_command_id') for output in failed if output.data.get('root_command_id')}):
    cancel_notifications([command_id], next(o.data['failed_reason'] for o in failed if o.data.get('root_command_id') == command_id))
  if count:
    print(f"[heartbeats] {count} runs stopped reporting for {config.silent_run_timeout_minutes:g} minutes: marked failed")
  return count
