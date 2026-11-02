"""
API tokens: their format, how we store and check them.

Format: `qab_pat_` + 40 random base62 characters + a 6-character base62 checksum (crc32 of the random part).
Service accounts' tokens start with `qab_svc_` (backend/service_accounts.py).
- The prefix tells what it is, so secret scanners (and people) recognize leaked QA-Board tokens.
- The checksum rejects typos and random strings without a database lookup.
We only store sha256(token): it has ~238 random bits, a salt or a slow hash wouldn't make it harder to guess.
Tokens created before this format (64 hex characters) still work, they're hashed the same way.
"""
import re
import hashlib
import datetime
import secrets
import zlib
from fnmatch import fnmatchcase
from typing import Optional, List

PREFIX = 'qab_pat_'
SERVICE_PREFIX = 'qab_svc_'
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


TOKEN_RE = re.compile(rf'^(?:{PREFIX}|{SERVICE_PREFIX})([0-9A-Za-z]{{{RANDOM_LENGTH}}})([0-9A-Za-z]{{{CHECKSUM_LENGTH}}})$')
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
  return datetime.datetime.utcnow()


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
         created_by=None, data: Optional[dict] = None, actor=None):
  """
  Creates a token for the user, added to the database session (the caller commits) and audited.
  Returns (token, secret): the secret is only known now.
  """
  from backend import db_session
  from .models import Token
  from .audit import audit
  secret = generate(SERVICE_PREFIX if kind == 'service' else PREFIX)
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
  audit('token.create', 'token', token.id, name, meta={
    "user": user.user_name, "kind": kind, "scopes": token.scopes, "projects": token.projects,
    "expires_at": iso(expires_at), "idle_expiry_days": idle_expiry_days,
  }, actor=actor)
  return token, secret


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
