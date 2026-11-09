"""
`qa batch` commands that QA-Board starts for users: tuning, "Run Tests", redoing runs...
Their scripts and logs are saved in the batch directory, and we remember them in batch.data.submissions:
users follow them with the batch's logs.
"""
import os
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

def pending_note(submission) -> Optional[str]:
  """
  Why `qa batch` didn't start yet (log_dir/log.pending.txt), while the submission waits and wrote no logs.
  None if there is none, or once `qa batch` started.
  """
  if not isinstance(submission, dict) or submission.get('status') not in ('submitting', 'submitted'):
    return None
  if not isinstance(submission.get('log_dir'), str) or not submission['log_dir']:
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
