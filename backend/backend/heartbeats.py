"""
Runs that stopped reporting, e.g. their machine was killed or lost the network: we mark them failed instead of
leaving them "running" forever.

- Clients that send heartbeats say so when the run starts (`heartbeat: true`, kept as data.heartbeat): `qa run`
  and qaboard.start_run() report at least every 2 minutes (qaboard/heartbeat.py:INTERVAL) while the run goes on (PATCH .../progress).
  Runs from older clients never say it: they are never failed for being silent.
- Each report about a running run sets outputs.reported_at (POST /api/v1/output/, PATCH .../progress).
- The jobs worker calls fail_silent_runs() (backend/jobs/worker.py): the runs silent for longer than
  $QABOARD_SILENT_RUN_TIMEOUT_MINUTES are failed, with data.silent_since saying when we last heard from them.
- A failed silent run that reports again is running again: what runs tell us is their state, not events.
"""
import logging
import datetime
from backend import clock
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm.attributes import flag_modified

from . import config
from .attempts import iso_utc

logger = logging.getLogger(__name__)


def reported(output, now: Optional[datetime.datetime] = None) -> None:
  """A running run told us something. Revives a run we failed because it was silent."""
  now = now or clock.utcnow()
  data = output.data or {}
  if 'silent_since' in data:
    output.data = {k: v for k, v in data.items() if k not in ('silent_since', 'failed_reason')}
    flag_modified(output, 'data')
    output.is_failed = False
    output.set_status(True, True, now=now)
  output.reported_at = now


def started(output, data: dict, now: Optional[datetime.datetime] = None) -> None:
  """
  What POST /api/v1/output/ says of a run: whether it sends heartbeats, and that it reported. A run we failed because
  it was silent reports again, even to say it ended: it wasn't dead after all.
  """
  if data.get('is_running'):
    if data.get('heartbeat'):
      output.data["heartbeat"] = True
    else:
      output.data.pop("heartbeat", None)
  if output.is_running:
    reported(output, now)
  elif output.data.pop("silent_since", None):
    output.data.pop("failed_reason", None)


def fail_silent_runs(now: Optional[datetime.datetime] = None) -> int:
  """Fails the running runs that send heartbeats and stayed silent too long. Returns how many."""
  from backend import db_session
  from .models import Output
  if not config.silent_run_timeout_minutes:
    return 0
  now = now or clock.utcnow()
  limit = now - datetime.timedelta(minutes=config.silent_run_timeout_minutes)
  # only runs that said they send heartbeats: those of older clients are never locked or loaded here
  silent = (Output.query
    .filter(Output.is_pending.is_(True), Output.is_running.is_(True), Output.reported_at < limit,
            text("(outputs.data->>'heartbeat') = 'true'"))
    # only the runs' rows: Output.test_input is loaded with an outer join, which PostgreSQL can't lock
    .with_for_update(skip_locked=True, of=Output).all())
  reasons = {}  # the batch's command: why one of its runs failed
  for output in silent:
    # like the runs "Fail stuck runs" fails (backend/run_activity.py:fail_runs), shown in Runs activity
    reason = f"Stopped reporting at {output.reported_at.strftime('%Y-%m-%d %H:%M')} UTC, e.g. its machine was killed or lost the network: marked as failed after {config.silent_run_timeout_minutes:g} minute{'' if config.silent_run_timeout_minutes == 1 else 's'}."
    output.data = {**(output.data or {}), 'silent_since': iso_utc(output.reported_at), 'failed_reason': reason}
    flag_modified(output, 'data')
    output.is_failed = True
    output.set_status(False, False, now=now)
    if output.data.get('root_command_id'):
      reasons[output.data['root_command_id']] = reason
  db_session.commit()
  # like for stuck runs: no "batch ended" email for batches whose runs we failed, but one saying why
  from .run_activity import cancel_notifications
  for command_id, reason in sorted(reasons.items()):
    cancel_notifications([command_id], reason)
  if silent:
    logger.info("%d runs stopped reporting for %g minutes: marked failed", len(silent), config.silent_run_timeout_minutes)
  return len(silent)
