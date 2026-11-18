"""
The token of a batch QA-Board starts (tuning, redo, `qa batch --commit`), for projects without a storage shared with
the server: their runs fetch the commit's artifacts and send their results over HTTP, which always needs a token
(backend/uploads.py). QA-Board gives them one of the user who started the batch:

- limited to the project, to reading and sending results (`read`, `ingest`): not starting batches or deleting;
- unused for a day, it expires (runs report every 2 minutes while they run), and after 30 days in any case;
- in the environment of `qa batch` on the server, in the driver pod's on Kubernetes; runners forward it to the runs,
  unlike other secrets (its prefix says what it is, qaboard/runners/env.py). Who can read the namespace's
  ConfigMaps can use it while it is valid: a namespace is a trust domain (docs/design/kubernetes-runner.md).

Projects with a shared storage don't get one: nothing changes for them.
"""
import datetime
from typing import Optional

from flask import g

from . import tokens

SCOPES = ['read', 'ingest']
IDLE_EXPIRY_DAYS = 1
MAX_DAYS = 30
# Where `qa batch` can run from artifacts sent to the server: the server's machine, which has them, and Kubernetes
# pods, which fetch them. Not LSF or Celery workers: they would need the uploads folder.
RUNNERS = ('local', 'kubernetes')


def needed(ci_commit) -> bool:
  """Whether the runs QA-Board starts from this commit need a token: their project has no shared storage"""
  return getattr(ci_commit, 'uploaded_artifacts_dir', None) is not None


def unsupported(ci_commit, runner: str) -> Optional[str]:
  """Why QA-Board can't start runs of this commit with `runner` (QABOARD_TUNING_RUNNER), if it can't"""
  if not needed(ci_commit) or runner in RUNNERS:
    return None
  return (f"This project has no storage shared with QA-Board: its runs fetch the commit's artifacts and send their "
          f"results over HTTP, which QA-Board's runner for batches ({runner}) can't do yet. Ask its administrators "
          f"to use the local or kubernetes runner, or start the batch from CI or a terminal with `qa batch`.")


def mint(ci_commit, command_id: str) -> Optional[str]:
  """
  The token for the runs of the batch `command_id`, if they need one (`needed`), of the signed-in user (g.actor).
  Saved in the database. Raises ValueError without a signed-in user.
  """
  if not needed(ci_commit):
    return None
  actor = g.get('actor')
  user = actor.user if actor is not None else None
  if user is None:
    raise ValueError("Sign in to start runs: they send their results with a token of yours.")
  from backend import db_session
  _, secret = tokens.mint(
    user, name=f"Batch {command_id[:8]} of {ci_commit.project_id}", scopes=SCOPES, kind='batch',
    projects=[ci_commit.project_id], expires_at=tokens.utcnow() + datetime.timedelta(days=MAX_DAYS),
    idle_expiry_days=IDLE_EXPIRY_DAYS, created_by=user, data={"command_id": command_id}, actor=actor,
  )
  db_session.commit()
  return secret
