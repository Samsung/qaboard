"""
Runs the jobs: `qaboard-admin jobs worker`, started by the backend's container next to the web server.

- Two lanes: maintenance jobs (hard deletes, cleanups... they can take hours) run one at a time, and users' jobs
  (kinds.INTERACTIVE, e.g. deleting their runs from "Storage usage") run next to them, so users don't wait.
- Starts the jobs of schedules when they're due, and keeps the storage usage up to date (backend/storage_usage.py).
- Several workers can run (e.g. one per replica): the database decides who runs what.
- On SIGTERM (deploys), running jobs stop at their next check and are queued again: they resume later.
- A heartbeat says it's alive: if it's killed, its jobs are queued again after a few minutes (queue.STALE_AFTER).
"""
import os
import signal
import socket
import datetime
import threading
import traceback

from sqlalchemy import update, text

from ..database import db_session, engine
from ..models import Job, JobWorker, JobSchedule
from . import queue, alerts
from .report import utcnow


HEARTBEAT_EVERY = 30  # seconds
PURGE_EVERY = 3600
USAGE_EVERY = 300
USAGE_LOCK = 802_517  # pg_advisory_lock key: one worker at a time updates the storage usage
# The worker schedules a nightly rebuild of the storage usage, and runs one if there was none. QABOARD_STORAGE_USAGE_AUTO=0 to manage it yourself.
USAGE_SCHEDULE = {"name": "Storage usage", "kind": "storage_usage", "cron": "17 3 * * *", "timezone": "UTC", "params": {}}
# And a daily update of users' groups, from LDAP and single sign-on (jobs/groups.py). QABOARD_GROUPS_SYNC_AUTO=0 to manage it yourself.
GROUPS_SCHEDULE = {"name": "Users' groups", "kind": "sync_groups", "cron": "41 4 * * *", "timezone": "UTC", "params": {}}


def storage_usage_auto() -> bool:
  return os.environ.get('QABOARD_STORAGE_USAGE_AUTO', '1') != '0'


def groups_sync_auto() -> bool:
  return os.environ.get('QABOARD_GROUPS_SYNC_AUTO', '1') != '0'


class Worker:
  def __init__(self, poll_seconds: float = 5, echo=True):
    self.id = f"{socket.gethostname()}:{os.getpid()}"
    self.poll_seconds = poll_seconds
    self.echo = echo
    self.stop_event = threading.Event()
    self.running = {}  # lane => job id
    self.purged_at = None
    self.usage_at = None
    self.usage_since = utcnow() - datetime.timedelta(hours=1)

  @property
  def job_id(self):
    return self.running.get('maintenance') or self.running.get('interactive')

  def stopping(self) -> bool:
    return self.stop_event.is_set()

  def stop(self, *args):
    if not self.stop_event.is_set():
      print(f"[worker {self.id}] stopping: running jobs will be queued again", flush=True)
    self.stop_event.set()

  def heartbeat(self):
    now = utcnow()
    with engine.begin() as connection:
      updated = connection.execute(update(JobWorker.__table__).where(JobWorker.__table__.c.id == self.id).values(seen_at=now, job_id=self.job_id)).rowcount
      if not updated:
        connection.execute(JobWorker.__table__.insert().values(id=self.id, started_at=now, seen_at=now, job_id=self.job_id, version=os.environ.get('QABOARD_VERSION')))
      job_ids = [i for i in self.running.values() if i]
      if job_ids:
        # also while a job does something long without reporting (e.g. deleting a huge folder)
        jobs = Job.__table__
        connection.execute(update(jobs).where(jobs.c.id.in_(job_ids), jobs.c.worker == self.id).values(heartbeat_at=now))

  def heartbeats(self):
    while not self.stop_event.wait(HEARTBEAT_EVERY):
      try:
        self.heartbeat()
      except Exception as e:
        print(f"[worker {self.id}] WARNING: heartbeat failed: {e}", flush=True)
        alerts.capture_exception(e)

  def defaults(self):
    """What every server needs: the storage usage, rebuilt nightly, and users' groups. Admins can change or disable the schedules."""
    if groups_sync_auto() and not JobSchedule.query.filter(JobSchedule.kind == 'sync_groups').first():
      queue.save_schedule(JobSchedule(), GROUPS_SCHEDULE)
      db_session.commit()
    if not storage_usage_auto():
      return
    if not JobSchedule.query.filter(JobSchedule.kind == 'storage_usage').first():
      queue.save_schedule(JobSchedule(), USAGE_SCHEDULE)
      db_session.commit()
    if not Job.query.filter(Job.kind == 'storage_usage').first():
      try:
        queue.create('storage_usage', {}, label='first start')
        db_session.commit()
      except queue.Busy:
        db_session.rollback()

  def refresh_usage(self):
    """The storage usage of the commits with new runs. One worker at a time."""
    from .. import storage_usage
    now = utcnow()
    if self.usage_at and (now - self.usage_at).total_seconds() < USAGE_EVERY:
      return
    self.usage_at = now
    with engine.connect() as lock:
      if not lock.execute(text("SELECT pg_try_advisory_lock(:key)"), {"key": USAGE_LOCK}).scalar():
        return
      try:
        # the runs' end updates their commit too: a margin for clocks and slow transactions
        storage_usage.refresh_recent(self.usage_since - datetime.timedelta(minutes=2))
        self.usage_since = now
      finally:
        lock.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": USAGE_LOCK})

  def housekeeping(self):
    queue.requeue_stale()
    queue.run_due_schedules()
    now = utcnow()
    if not self.purged_at or (now - self.purged_at).total_seconds() > PURGE_EVERY:
      queue.purge_old_errors(now)
      self.purged_at = now
    if storage_usage_auto():
      try:
        self.refresh_usage()
      except Exception as e:
        db_session.rollback()
        print(f"[worker {self.id}] WARNING: could not update the storage usage: {traceback.format_exc()}", flush=True)
        alerts.capture_exception(e)

  def run_next(self, lane: str) -> bool:
    """The next job of the lane, if there's one. Returns whether a job ran."""
    job_id = queue.claim(self.id, interactive=lane == 'interactive')
    if job_id is None:
      return False
    self.running[lane] = job_id
    self.heartbeat()
    print(f"[worker {self.id}] running job {job_id}", flush=True)
    try:
      status = queue.run(job_id, stopping=self.stopping, echo=self.echo)
      print(f"[worker {self.id}] job {job_id}: {status}", flush=True)
    finally:
      self.running[lane] = None
      db_session.remove()
    return True

  def tick(self, lanes=('maintenance', 'interactive')):
    """Housekeeping, then the next job of each lane. Returns whether a job ran."""
    if 'maintenance' in lanes:
      self.housekeeping()
    ran = False
    for lane in lanes:
      ran = self.run_next(lane) or ran
    return ran

  def lane_loop(self, lanes, once=False):
    while not self.stopping():
      try:
        ran = self.tick(lanes)
      except Exception as e:
        # e.g. the database restarts: we try again
        print(f"[worker {self.id}] ERROR: {traceback.format_exc()}", flush=True)
        alerts.capture_exception(e)
        db_session.remove()
        ran = False
      if once and not ran:
        break
      if not ran:
        self.stop_event.wait(self.poll_seconds)
    db_session.remove()

  def loop(self, once=False):
    """`once`: run what's queued and due, then return (e.g. from a cron job, or in tests), in this thread"""
    if threading.current_thread() is threading.main_thread():
      signal.signal(signal.SIGTERM, self.stop)
      signal.signal(signal.SIGINT, self.stop)
    self.heartbeat()
    beats = threading.Thread(target=self.heartbeats, daemon=True)
    beats.start()
    try:
      self.defaults()
    except Exception as e:
      db_session.rollback()
      print(f"[worker {self.id}] WARNING: {traceback.format_exc()}", flush=True)
      alerts.capture_exception(e)
    print(f"[worker {self.id}] waiting for jobs", flush=True)
    try:
      if once:
        self.lane_loop(('maintenance', 'interactive'), once=True)
      else:
        interactive = threading.Thread(target=self.lane_loop, args=(('interactive',),), daemon=True)
        interactive.start()
        self.lane_loop(('maintenance',))
        interactive.join(timeout=120)
    finally:
      self.stop_event.set()
      try:
        with engine.begin() as connection:
          connection.execute(JobWorker.__table__.delete().where(JobWorker.__table__.c.id == self.id))
      except Exception:
        pass
