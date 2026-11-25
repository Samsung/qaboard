"""
API tokens: their format, how we store and check them.

Format: `qab_pat_` + 40 random base62 characters + a 6-character base62 checksum (crc32 of the random part).
Service accounts' tokens start with `qab_svc_` (backend/service_accounts.py), and the short-lived tokens the server
issues (CI jobs' token exchange, backend/ci_trust.py) with `qab_tmp_`.
- The prefix tells what it is, so secret scanners (and people) recognize leaked QA-Board tokens.
- The checksum rejects typos and random strings without a database lookup.
We only store sha256(token): it has ~238 random bits, a salt or a slow hash wouldn't make it harder to guess.
Tokens created before this format (64 hex characters) still work, they're hashed the same way.
"""
import logging
import re
import hashlib
import datetime
from backend import clock
import secrets
import zlib
from fnmatch import fnmatchcase
from typing import Optional, List

from qaboard.conventions import BATCH_TOKEN_PREFIX, Reason

logger = logging.getLogger(__name__)

PREFIX = 'qab_pat_'
SERVICE_PREFIX = 'qab_svc_'
TEMPORARY_PREFIX = 'qab_tmp_'
# the token of a batch QA-Board starts (tokens.mint_for_batch): runners forward it to the runs' pods
BATCH_PREFIX = BATCH_TOKEN_PREFIX
# token kinds that the server issues for a short time
TEMPORARY_KINDS = ('ci', 'batch')
BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
RANDOM_LENGTH = 40
CHECKSUM_LENGTH = 6
# what we show to recognize a token
DISPLAY_LENGTH = 12

# What tokens can do, on top of what their user can do. Sessions can do everything their user can.
SCOPES = {
  'read': "Read projects, runs and files",
  'ingest': "Send runs, batches and commits (qa run, qa batch)",
  'act': "Redo runs, start or delete batches, save milestones",
  'admin': "Use the admin API (admins only)",
}
# What tokens created before scopes can do: everything but the admin API, which came later
LEGACY_SCOPES = ['read', 'ingest', 'act']
# tokens created by `qa auth login`
CLI_SCOPES = ['read', 'ingest', 'act']


def base62(number: int, length: int) -> str:
  chars = []
  for _ in range(length):
    number, remainder = divmod(number, 62)
    chars.append(BASE62[remainder])
  return ''.join(reversed(chars))


def checksum(random_part: str) -> str:
  return base62(zlib.crc32(random_part.encode()), CHECKSUM_LENGTH)


def generate(prefix: str = PREFIX) -> str:
  random_part = ''.join(secrets.choice(BASE62) for _ in range(RANDOM_LENGTH))
  return f"{prefix}{random_part}{checksum(random_part)}"


TOKEN_RE = re.compile(rf'^(?:{PREFIX}|{SERVICE_PREFIX}|{TEMPORARY_PREFIX}|{BATCH_PREFIX})([0-9A-Za-z]{{{RANDOM_LENGTH}}})([0-9A-Za-z]{{{CHECKSUM_LENGTH}}})$')
LEGACY_RE = re.compile(r'^[0-9a-f]{64}$')

def is_well_formed(token: str) -> bool:
  """Whether this looks like one of our tokens, checksum included"""
  match = TOKEN_RE.match(token)
  if match:
    return checksum(match.group(1)) == match.group(2)
  return bool(LEGACY_RE.match(token))


def hash_token(token: str) -> str:
  return hashlib.sha256(token.encode()).hexdigest()


def display_prefix(token: str) -> str:
  return token[:DISPLAY_LENGTH]


def utcnow() -> datetime.datetime:
  return clock.utcnow()


def status(token, now: Optional[datetime.datetime] = None) -> str:
  """active, revoked, expired, or idle_expired (unused for too long)"""
  now = now or utcnow()
  if token.revoked or token.revoked_at:
    return 'revoked'
  if token.expires_at and now >= token.expires_at:
    return 'expired'
  if token.idle_expiry_days:
    last_used = token.last_used_at or token.created_at
    if last_used and now >= last_used + datetime.timedelta(days=token.idle_expiry_days):
      return 'idle_expired'
  return 'active'


def scopes_of(token) -> List[str]:
  """Legacy tokens predate scopes"""
  if token.kind == 'legacy':
    return list(LEGACY_SCOPES)
  return list(token.scopes or [])


def matches_project(patterns: List[str], project_id: Optional[str]) -> bool:
  """
  Whether a token restricted to `patterns` can access a project. A pattern also covers its sub-projects:
  "group/repo" covers "group/repo/sub", and "group/*" covers every project of the group.
  """
  if not patterns:
    return True
  if not project_id:
    return False
  for pattern in patterns:
    pattern = pattern.strip().rstrip('/')
    if not pattern:
      continue
    if project_id == pattern or project_id.startswith(pattern + '/'):
      return True
    if any(c in pattern for c in '*?[') and (fnmatchcase(project_id, pattern) or fnmatchcase(project_id, pattern + '/*')):
      return True
  return False


def clean_project_patterns(patterns) -> List[str]:
  if patterns is None:
    return []
  if isinstance(patterns, str):
    patterns = [p for p in re.split(r'[\s,]+', patterns)]
  if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
    raise ValueError("`projects` must be a list of project patterns, e.g. [\"group/repo\", \"group/*\"]")
  cleaned = []
  for p in patterns:
    p = p.strip().strip('/')
    if p and p not in cleaned:
      cleaned.append(p)
  return cleaned


def serialize(token, with_user=False) -> dict:
  info = {
    "id": token.id,
    "name": token.name,
    "kind": token.kind,
    "prefix": token.prefix,
    "scopes": scopes_of(token),
    "projects": token.projects or [],
    "created_at": iso(token.created_at),
    "expires_at": iso(token.expires_at),
    "idle_expiry_days": token.idle_expiry_days,
    "last_used_at": iso(token.last_used_at),
    "last_used_ip": token.last_used_ip,
    "revoked_at": iso(token.revoked_at),
    "status": status(token),
    "legacy": token.kind == 'legacy',
    "data": token.data or {},
  }
  if with_user:
    user = token.user
    info["user"] = {"id": user.id, "user_name": user.user_name, "full_name": user.full_name} if user else None
  return info


def iso(date: Optional[datetime.datetime]) -> Optional[str]:
  # naive datetimes are UTC
  if date is None:
    return None
  if date.tzinfo is None:
    date = date.replace(tzinfo=datetime.timezone.utc)
  return date.isoformat()


def mint(user, name: str, scopes: List[str], kind: str = 'personal', projects: Optional[List[str]] = None,
         expires_at: Optional[datetime.datetime] = None, idle_expiry_days: Optional[int] = None,
         created_by=None, data: Optional[dict] = None, actor=None, audit_action: str = 'token.create',
         audit_meta: Optional[dict] = None):
  """
  Creates a token for the user, added to the database session (the caller commits) and audited (`audit_action`, e.g.
  token.exchange for CI jobs' tokens, with `audit_meta`). Returns (token, secret): the secret is only known now.
  """
  from backend import db_session
  from .models import Token
  from .audit import audit
  secret = generate(SERVICE_PREFIX if kind == 'service' else BATCH_PREFIX if kind == 'batch' else TEMPORARY_PREFIX if kind in TEMPORARY_KINDS else PREFIX)
  token = Token(
    token_hash=hash_token(secret),
    prefix=display_prefix(secret),
    kind=kind,
    name=name,
    user_id=user.id,
    user=user,
    created_by_id=created_by.id if created_by is not None else None,
    scopes=[s for s in SCOPES if s in scopes],
    projects=projects or [],
    created_at=utcnow(),
    expires_at=expires_at,
    idle_expiry_days=idle_expiry_days,
    revoked=False,
    data=data or {},
  )
  db_session.add(token)
  db_session.flush()
  audit(audit_action, 'token', token.id, name, meta={
    "user": user.user_name, "kind": kind, "scopes": token.scopes, "projects": token.projects,
    "expires_at": iso(expires_at), "idle_expiry_days": idle_expiry_days, **(audit_meta or {}),
  }, actor=actor)
  return token, secret



# The runners through which QA-Board starts batches whose jobs don't get the server's environment, so no token
RUNNERS_WITHOUT_TOKEN = ('lsf', 'bridge')
# After the batch's last run ended, its driver may still send the end of its log
ENDED_BATCH_GRACE = datetime.timedelta(minutes=10)


def batch_needs_token(ci_commit) -> bool:
  """
  Whether the runs of a batch QA-Board starts on this commit need a token of their own: they send their files over
  HTTP (artifacts `qa save-artifacts` sent, CiCommit.uploaded_artifacts_dir: always, backend/uploads.py), or the
  server refuses results without a token (ingest.auth: token).
  """
  if ci_commit.uploaded_artifacts_dir is not None:
    return True
  from .settings import setting
  return setting('ingest.auth') == 'token'


def mint_for_batch(actor, ci_commit, command_id: str, runner: str, *, batch_label: str, log_dir=None, until_stopped: bool = False,
                   optimize: bool = False) -> Optional[str]:
  """
  The token of the runs of a batch QA-Board starts (tuning, redo, `qa batch --commit`) with `runner`, if they need
  one (batch_needs_token), else None. None too for RUNNERS_WITHOUT_TOKEN: artifacts.runner_unsupported refuses them
  first when a token is needed. It is `actor`'s, who starts the batch:
  - limited to the project, to reading and sending results (`read`, `ingest`), and it only sends the results of its own
    batch: the commit and `batch_label` (and with `optimize`, the `qa optimize` iterations "<label>|iter<N>"), see
    batch_allows;
  - revoked when the batch is stopped (revoke_batch_tokens), or ENDED_BATCH_GRACE after its last run ended
    (end_batch_token), unless `until_stopped`: `qa optimize` starts batch after batch with the same command id, and a
    redo runs pending runs that `qa batch` doesn't register again under its command id;
  - unused for a day it expires (runs report every 2 minutes), and after 30 days in any case;
  - in the environment of `qa batch`, in the driver pod's on Kubernetes. Runners forward it to the runs, unlike other
    secrets: its prefix says what it is (qaboard/runners/env.py). Who reads a namespace's ConfigMaps can use it while
    it is valid: a namespace is a trust domain (docs/design/kubernetes-runner.md).
  `log_dir`: the batch's folder of scripts and logs, where its driver may send its log (PUT .../submissions/<id>/log).
  Saved in the database. Raises ValueError without a signed-in user.
  """
  if runner in RUNNERS_WITHOUT_TOKEN or not batch_needs_token(ci_commit):
    return None
  user = actor.user if actor is not None else None
  if user is None:
    raise ValueError("Sign in to start runs: they send their results with a token of yours.")
  from backend import db_session
  _, secret = mint(
    user, name=f"Batch {command_id[:8]} of {ci_commit.project_id}", scopes=['read', 'ingest'], kind='batch',
    projects=[ci_commit.project_id], expires_at=utcnow() + datetime.timedelta(days=30), idle_expiry_days=1,
    created_by=user, actor=actor, data={
      "command_id": command_id, **({"log_dir": str(log_dir)} if log_dir else {}), **({"until_stopped": True} if until_stopped else {}),
      # its batch (batch_allows)
      "project": ci_commit.project_id, "commit": ci_commit.hexsha, "batch": batch_label, **({"optimize": True} if optimize else {}),
    },
  )
  db_session.commit()
  return secret


# Why a batch token is refused (the `reason` of the 403s): it was used outside of its batch
BATCH_TOKEN_REFUSAL = Reason.BATCH_TOKEN_LIMITED


def is_batch_token(token) -> bool:
  return getattr(token, 'kind', None) == 'batch'


def batch_label_allowed(data: dict, batch_label: Optional[str]) -> bool:
  """
  Whether a batch token minted with `data` may send results to the batch `batch_label`: its own, and for
  `qa optimize` the batches of its iterations, "<label>|iter<N>" (qaboard/optimize.py)
  """
  own = data.get('batch')
  if not isinstance(own, str) or not isinstance(batch_label, str):
    return False
  if batch_label == own:
    return True
  return bool(data.get('optimize')) and re.fullmatch(re.escape(own) + r"\|iter\d+", batch_label) is not None


def batch_allows(token, project_id: Optional[str], hexsha: Optional[str], batch_label: Optional[str] = None, any_batch: bool = False) -> bool:
  """
  Whether a batch token (mint_for_batch) may send results of this commit, and of this batch unless `any_batch`
  (commits). Its batch is a commit and a label, whichever way the server started it:
  - tuning and `qa batch --commit`: the label of the form;
  - `qa optimize`: the label, and its iterations' (other batches, with the same command id);
  - redo: the label of the batch whose runs are done again. Pending runs keep the command id of the `qa batch` that
    first registered them, so the command id can't tell its runs.
  Sub-projects of its project too: a batch can run theirs, e.g. a monorepo's. Batch tokens that don't say their batch
  (none shipped in a release) can't send anything. Their commit must exist: they never create commits or projects
  (CiCommit.get_or_create's existing_only).
  """
  data = token.data or {}
  commit = data.get('commit')
  # exactly its commit: the full lowercase id. Commits are looked up by prefix, and case-sensitively: another
  # spelling would create another commit (uploads.FULL_COMMIT_ID)
  if not isinstance(commit, str) or not isinstance(hexsha, str) or not re.fullmatch(r'[0-9a-f]{40}', hexsha) or hexsha != commit:
    return False
  if not data.get('project') or not project_id or not matches_project([data['project']], project_id):
    return False
  return any_batch or batch_label_allowed(data, batch_label)


def batch_description(token) -> str:
  data = token.data or {}
  commit, label = data.get('commit') or '?', data.get('batch') or '?'
  iterations = f" (and its iterations, {label}|iter<N>)" if data.get('optimize') else ''
  return f"the batch \"{label}\"{iterations} of the commit {commit[:8]} of {data.get('project') or '?'}"


def active_batch_tokens(command_ids: List[str]):
  """The batch tokens of these commands that are not revoked or expired"""
  from .models import Token
  ids = [str(i) for i in command_ids if i]
  if not ids:
    return []
  return (Token.query
          .filter(Token.kind == 'batch', Token.revoked.isnot(True), Token.revoked_at.is_(None),
                  Token.expires_at > utcnow(), Token.data['command_id'].astext.in_(ids))
          .all())


def batch_token_for(actor, command_id: str):
  """The token the request came with, if it is the batch `command_id`'s own and knows its folder of logs, else None"""
  token = actor.token if actor is not None else None
  data = (token.data or {}) if token is not None else {}
  if token is None or token.kind != 'batch' or data.get('command_id') != command_id or not data.get('log_dir') or len(token.projects or []) != 1:
    return None
  return token


def revoke_batch_tokens(command_ids: List[str], reason: str, actor=None) -> int:
  """
  Revokes the tokens of these batches (e.g. they were stopped), and commits. Returns how many. Never raises: it
  happens after what users asked for (stopping a batch, reporting why it failed to start), which must not fail.
  """
  from backend import db_session
  try:
    revoked = [token for token in active_batch_tokens(command_ids) if revoke(token, reason=reason, actor=actor)]
    if revoked:
      db_session.commit()
    return len(revoked)
  except Exception as e:
    logger.warning("Could not revoke the tokens of the batches %s: %s: %s", command_ids, type(e).__name__, e)
    db_session.rollback()
    return 0


def end_batch_token(session, command_id: Optional[str]) -> None:
  """
  Called when a run of the batch `command_id` ended (POST /api/v1/output/): once none of its runs are pending, the
  batch's token expires ENDED_BATCH_GRACE later, time for its driver to send the end of its log. `qa batch` tells
  QA-Board about all its runs before it starts any, and runs started by nested `qa batch` commands (pipelines) end
  before the run that started them. Not for tokens `until_stopped`. Never raises: it must not get in the way of
  saving results.
  """
  if not command_id:
    return
  try:
    tokens = [t for t in active_batch_tokens([command_id]) if not (t.data or {}).get('until_stopped')]
    if not tokens:
      return
    from .notifications.batches import has_pending_runs
    if session.execute(has_pending_runs, {"command_id": str(command_id)}).first():
      return
    expires_at = utcnow() + ENDED_BATCH_GRACE
    for token in tokens:
      token.expires_at = min(token.expires_at, expires_at) if token.expires_at else expires_at
    session.commit()
  except Exception as e:
    logger.warning("Could not end the token of the batch %s: %s: %s", command_id, type(e).__name__, e)
    session.rollback()


def revoke(token, by=None, reason: Optional[str] = None, actor=None):
  """Revokes a token (added to the session, the caller commits) and audits it"""
  from .audit import audit
  if status(token) == 'revoked':
    return False
  token.revoked = True
  token.revoked_at = utcnow()
  token.revoked_by_id = by.id if by is not None else None
  audit('token.revoke', 'token', token.id, token.name, meta={"user": token.user.user_name if token.user else None, **({"reason": reason} if reason else {})}, actor=actor)
  return True
