"""
Where runs come from, and who started them: saved on runs (output.data.origin) and batches (Batch.origin, user_name,
user_id), so that pages can show users their own work and hide the CI's (see docs/home-and-project-pages-proposal.md).

- `webapp`: started from QA-Board (tuning, Run Tests, redo). The server records them in batch.data.submissions, and
  `qa batch` sends their id as its command id (QA_BATCH_COMMAND_ID), or the run's root_command_id.
- `ci`: sent by a CI pipeline: with a service account's token, or the CLI says so (`run_context.origin`, from the CI
  providers' variables). Older clients only send `job_type`, which is "ci" for the web app's runs too (they export
  CI=true): we check submissions first.
- `local`: from someone's terminal.

A batch keeps the origin and the user of whoever created it: when users redo some runs of the CI's batch from the web
app, it stays the CI's (its runs say they're from the web app). Except that the CI wins over local runs: people who
`qa --share batch` before pushing use the CI's labels.
"""
import datetime
from typing import Optional

ORIGINS = ('webapp', 'local', 'ci')


def submission_ids(batch_data) -> set:
  submissions = (batch_data or {}).get('submissions')
  return set(submissions) if isinstance(submissions, dict) else set()


def is_service_account(submitted_by) -> bool:
  """Results sent with a service account's token are the CI's"""
  if not submitted_by or not submitted_by.get('user_id'):
    return False
  try:
    from .models import User
    from .database import db_session
    user = db_session.get(User, submitted_by['user_id'])
  except Exception:  # unit tests, without a database
    return False
  return user is not None and user.kind == 'service'


def run_origin(data: dict, batch_data=None, submitted_by=None, command_ids=()) -> str:
  """
  `data`: what `qa` sent (run_context, job_type...), `batch_data`: the batch's data, `command_ids`: the ids of the
  `qa batch` commands that sent it (root_command_id, or the ids in `command`).
  """
  context = data.get('run_context') if isinstance(data.get('run_context'), dict) else {}
  submissions = submission_ids(batch_data)
  if context.get('origin') == 'webapp' or any(str(i) in submissions for i in command_ids if i):
    return 'webapp'
  if is_service_account(submitted_by):
    return 'ci'
  if context.get('origin') in ORIGINS:
    return context['origin']
  # older clients
  return 'ci' if data.get('job_type') == 'ci' else 'local'


def clean_run_context(context) -> dict:
  """What we keep from the CLI's run_context, to show: links must be http(s), texts short"""
  if not isinstance(context, dict):
    return {}
  clean = {}
  for key in ('origin', 'provider', 'triggered_by'):
    if isinstance(context.get(key), str) and context[key]:
      clean[key] = context[key][:200]
  for key in ('pipeline_url', 'job_url'):
    url = context.get(key)
    if isinstance(url, str) and url.startswith(('https://', 'http://')) and len(url) < 2000:
      clean[key] = url
  return clean


def run_user(data: dict, submitted_by=None) -> Optional[str]:
  """Who started it: the verified user, else who the CLI says it runs as (QA_USER, $USER)"""
  if submitted_by and submitted_by.get('user_name'):
    return submitted_by['user_name']
  user = data.get('user')
  return str(user) if user else None


def claim_batch(batch, origin: str, user_name: Optional[str], user_id: Optional[int] = None):
  """
  The first origin and user of a batch are its own, see above. Fills them in for batches from before we saved them.
  `user_id`: the verified user, if `user_name` is theirs.
  """
  if getattr(batch, 'origin', None) is None or (batch.origin == 'local' and origin == 'ci'):
    batch.origin = origin
    batch.user_name, batch.user_id = user_name, user_id
  elif getattr(batch, 'user_name', None) is None and user_name:
    batch.user_name, batch.user_id = user_name, user_id
  elif user_id is not None and getattr(batch, 'user_id', None) is None and batch.user_name == user_name:
    # the same user, verified this time
    batch.user_id = user_id
  if getattr(batch, 'latest_output_datetime', None) is None:
    # lists of batches are sorted by it
    batch.latest_output_datetime = datetime.datetime.utcnow()

