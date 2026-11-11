"""
`qa batch` commands that QA-Board starts for users: tuning, "Run Tests", redoing runs...
Their scripts and logs are saved in the batch directory, and we remember them in batch.data.submissions:
users follow them with the batch's logs.
"""
import os
import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy.orm.attributes import flag_modified


def user_batch_dir(batch_dir, user) -> Path:
  """The batch directory, for runs started by `user` (results from the CI are saved under the CI user's folder)"""
  default_user = os.environ.get('QABOARD_DEFAULT_USER', 'qaboard')
  return Path(str(batch_dir).replace(f'/outputs/{default_user}/', f'/outputs/{user}/'))


def submission_dir(batch_dir, created_at, command_id) -> Path:
  """Where we save the scripts and logs of a `qa batch` started from QA-Board"""
  return Path(batch_dir) / 'qaboard-batches' / f"{created_at.strftime('%Y%m%d-%H%M%S')}-{command_id[:8]}"


# While `qa batch` waits to start, e.g. its Kubernetes driver pod is pending, the runner says why in this file, next
# to its log.txt (the kubernetes runner's submit_detached)
PENDING_NOTE_FILE = 'log.pending.txt'
PENDING_NOTE_MAX_BYTES = 4096
# Batches are serialized often, and their submissions stay "submitted" (the server doesn't follow Kubernetes drivers,
# nor LSF jobs): we look at the storage only for recent ones, that may still wait to start
PENDING_NOTE_MAX_AGE = datetime.timedelta(hours=24)

def submission_created_at(submission) -> Optional[datetime.datetime]:
  """When the submission was created (its "created_at", e.g. 2026-11-10T09:00:00.123456Z), in UTC. None if unknown"""
  value = submission.get('created_at') if isinstance(submission, dict) else None
  if not isinstance(value, str):
    return None
  try:
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
  except ValueError:
    return None
  return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def pending_note(submission, now: Optional[datetime.datetime] = None) -> Optional[str]:
  """
  Why `qa batch` didn't start yet (log_dir/log.pending.txt), while the submission waits and wrote no logs.
  None if there is none, or once `qa batch` started. Only for Kubernetes drivers created in the last
  PENDING_NOTE_MAX_AGE: for others, we don't read the storage.
  """
  if not isinstance(submission, dict) or submission.get('status') not in ('submitting', 'submitted'):
    return None
  if submission.get('runner') != 'kubernetes':
    return None
  if not isinstance(submission.get('log_dir'), str) or not submission['log_dir']:
    return None
  created = submission_created_at(submission)
  now = now or datetime.datetime.now(datetime.timezone.utc)
  if created is None or not (now - PENDING_NOTE_MAX_AGE <= created <= now + datetime.timedelta(minutes=5)):
    return None
  log_dir = Path(submission['log_dir'])
  try:
    if (log_dir / 'log.txt').stat().st_size > 0:
      return None
  except OSError:
    pass
  try:
    with (log_dir / PENDING_NOTE_FILE).open('rb') as f:
      note = f.read(PENDING_NOTE_MAX_BYTES).decode('utf-8', errors='replace').strip()
  except (OSError, TypeError, ValueError):
    return None
  return note or None


def append_log(log_dir, text: str) -> bool:
  """
  Tells users in log_dir/log.txt what went wrong. Never raises: e.g. a Kubernetes pod already created the file as
  another UID, and this error would hide the one we report. Returns whether it was written.
  """
  try:
    with (Path(log_dir) / 'log.txt').open('a') as log:
      log.write(text)
    return True
  except OSError as e:
    print(f"WARNING: could not write in {log_dir}/log.txt: {e}\n{text}")
    return False


def startup_logs(log_dir, size: Optional[int] = None) -> Optional[str]:
  """
  Why `qa batch` was pending (log_dir/log.pending.txt, from its runner) then what it wrote (log.txt), to tell users
  why it failed to start. None if there is neither. With `size`, only the end.
  """
  parts = []
  for name in (PENDING_NOTE_FILE, 'log.txt'):
    try:
      parts.append((Path(log_dir) / name).read_text(errors='replace'))
    except OSError:
      continue
  if not parts:
    return None
  text = "\n".join(part.rstrip('\n') for part in parts if part) + ("\n" if any(parts) else "")
  return text[-size:] if size else text


# We keep the history of the last batches started from QA-Board
MAX_SUBMISSIONS = 20

def record_submission(batch, submission):
  """
  Remember in batch.data.submissions how users started the batch from QA-Board.
  QA-Board uses it to show the status of `qa batch`, and its logs.
  """
  data = batch.data or {}
  submissions = {**data.get('submissions', {}), submission['id']: submission}
  if len(submissions) > MAX_SUBMISSIONS:
    recent = sorted(submissions.values(), key=lambda s: s.get('created_at', ''))[-MAX_SUBMISSIONS:]
    submissions = {s["id"]: s for s in recent}
  batch.data = {**data, 'submissions': submissions}
  flag_modified(batch, "data")
  # batches created to run this are the web app's, and the user's
  from .origins import claim_batch
  claim_batch(batch, 'webapp', submission.get('user'), submitting_user_id())


def submitting_user_id():
  """The signed-in user who started it, if any"""
  try:
    from flask import g
    user = g.actor.user
    return user.id if user is not None else None
  except Exception:  # outside of requests, e.g. the unit tests
    return None
