"""
`qa batch` commands that QA-Board starts for users: tuning, "Run Tests", redoing runs...
Their scripts and logs are saved in the batch directory, and we remember them in batch.data.submissions:
users follow them with the batch's logs.
"""
import os
from pathlib import Path

from sqlalchemy.orm.attributes import flag_modified


def user_batch_dir(batch_dir, user) -> Path:
  """The batch directory, for runs started by `user` (results from the CI are saved under the CI user's folder)"""
  default_user = os.environ.get('QABOARD_DEFAULT_USER', 'qaboard')
  return Path(str(batch_dir).replace(f'/outputs/{default_user}/', f'/outputs/{user}/'))


def submission_dir(batch_dir, created_at, command_id) -> Path:
  """Where we save the scripts and logs of a `qa batch` started from QA-Board"""
  return Path(batch_dir) / 'qaboard-batches' / f"{created_at.strftime('%Y%m%d-%H%M%S')}-{command_id[:8]}"


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
