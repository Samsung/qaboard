"""
Runs the jobs: `qaboard-admin jobs worker`, in its own container/process next to the backend.

- Claims queued jobs one at a time, and starts the jobs of schedules when they're due.
- Several workers can run (e.g. one per host): the database decides who runs what.
- On SIGTERM (deploys), the running job stops at its next check and is queued again: it resumes later.
- A heartbeat says it's alive: if it's killed, its job is queued again after a few minutes (queue.STALE_AFTER).
"""
import os
import signal
import socket
import threading
import traceback

from sqlalchemy import update

from ..database import db_session, engine
from ..models import Job, JobWorker
from . import queue
from .report import utcnow


HEARTBEAT_EVERY = 30  # seconds
PURGE_EVERY = 3600


class Worker:
  def __init__(self, poll_seconds: float = 5, echo=True):
    self.id = f"{socket.gethostname()}:{os.getpid()}"
    self.poll_seconds = poll_seconds
    self.echo = echo
    self.stop_event = threading.Event()
    self.job_id = None
    self.purged_at = None

  def stopping(self) -> bool:
    return self.stop_event.is_set()

  def stop(self, *args):
    if not self.stop_event.is_set():
      print(f"[worker {self.id}] stopping: the running job will be queued again", flush=True)
    self.stop_event.set()

  def heartbeat(self):
    now = utcnow()
    with engine.begin() as connection:
      updated = connection.execute(update(JobWorker.__table__).where(JobWorker.__table__.c.id == self.id).values(seen_at=now, job_id=self.job_id)).rowcount
      if not updated:
        connection.execute(JobWorker.__table__.insert().values(id=self.id, started_at=now, seen_at=now, job_id=self.job_id, version=os.environ.get('QABOARD_VERSION')))
      if self.job_id:
        # also while a job does something long without reporting (e.g. deleting a huge folder)
        connection.execute(update(Job.__table__).where(Job.__table__.c.id == self.job_id, Job.__table__.c.worker == self.id).values(heartbeat_at=now))

  def heartbeats(self):
    while not self.stop_event.wait(HEARTBEAT_EVERY):
      try:
        self.heartbeat()
      except Exception as e:
        print(f"[worker {self.id}] WARNING: heartbeat failed: {e}", flush=True)

  def tick(self):
    """Housekeeping, then the next job if there's one. Returns whether a job ran."""
    queue.requeue_stale()
    queue.run_due_schedules()
    now = utcnow()
    if not self.purged_at or (now - self.purged_at).total_seconds() > PURGE_EVERY:
      queue.purge_old_errors(now)
      self.purged_at = now
    job_id = queue.claim(self.id)
    if job_id is None:
      return False
    self.job_id = job_id
    self.heartbeat()
    print(f"[worker {self.id}] running job {job_id}", flush=True)
    try:
      status = queue.run(job_id, stopping=self.stopping, echo=self.echo)
      print(f"[worker {self.id}] job {job_id}: {status}", flush=True)
    finally:
      self.job_id = None
      db_session.remove()
    return True

  def loop(self, once=False):
    """`once`: run what's queued and due, then return (e.g. from a cron job, or in tests)"""
    if threading.current_thread() is threading.main_thread():
      signal.signal(signal.SIGTERM, self.stop)
      signal.signal(signal.SIGINT, self.stop)
    self.heartbeat()
    beats = threading.Thread(target=self.heartbeats, daemon=True)
    beats.start()
    print(f"[worker {self.id}] waiting for jobs", flush=True)
    try:
      while not self.stopping():
        try:
          ran = self.tick()
        except Exception:
          # e.g. the database restarts: we try again
          print(f"[worker {self.id}] ERROR: {traceback.format_exc()}", flush=True)
          db_session.remove()
          ran = False
        if once and not ran:
          break
        if not ran:
          self.stop_event.wait(self.poll_seconds)
    finally:
      self.stop_event.set()
      try:
        with engine.begin() as connection:
          connection.execute(JobWorker.__table__.delete().where(JobWorker.__table__.c.id == self.id))
      except Exception:
        pass
