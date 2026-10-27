"""
Browser sessions, stored in the database so they can be listed and revoked. The cookie (Flask's signed session) only
holds an opaque id, `session['sid']`, whose hash is the row's. backend/actor.py checks it at each request.
Sessions slide: they end after `sessions.idle_days` without activity, and anyway after `sessions.max_days`.
"""
import secrets
import datetime
from typing import Optional

from flask import session, g, request, has_request_context

from ..settings import setting
from ..tokens import hash_token, utcnow, iso


# How often we save when a session was last seen
LAST_SEEN_EVERY = datetime.timedelta(minutes=5)
# The cookie's own lifetime: the row says when the session really ends
COOKIE_LIFETIME = datetime.timedelta(days=365)


def start(user, provider_id: Optional[str] = None):
  """Opens a session for the user, in the current request's cookie. The caller commits."""
  if getattr(user, 'kind', 'human') == 'service':
    # the sign-in methods don't find them: this is the last line of defense
    raise PermissionError(f"Service accounts only use tokens, they can't sign in: {user.user_name}")
  from backend import db_session
  from ..models import UserSession
  from ..audit import client_ip
  # a new id at each sign-in: a session id someone planted before can't be reused (session fixation)
  for key in ('_user_id', '_fresh', '_id', '_remember', 'samlUserdata', 'sid'):
    session.pop(key, None)
  secret = secrets.token_urlsafe(32)
  now = utcnow()
  row = UserSession(
    id_hash=hash_token(secret),
    user_id=user.id,
    provider_id=provider_id,
    created_at=now,
    last_seen_at=now,
    expires_at=now + datetime.timedelta(days=setting('sessions.max_days')),
    ip=client_ip(),
    user_agent=request.headers.get('User-Agent', '')[:500] if has_request_context() else None,
  )
  db_session.add(row)
  session['sid'] = secret
  session.permanent = True
  g.session_row = row
  return row


def status(row, now=None) -> str:
  """active, revoked, expired, idle"""
  now = now or utcnow()
  if row.revoked_at:
    return 'revoked'
  if now >= row.expires_at:
    return 'expired'
  if now >= row.last_seen_at + datetime.timedelta(days=setting('sessions.idle_days')):
    return 'idle'
  return 'active'


def current():
  """The session row of the request's cookie, if it's still valid. Else None, and the cookie forgets it."""
  from backend import db_session
  from ..models import UserSession
  secret = session.get('sid')
  if not secret:
    return None
  row = UserSession.query.filter(UserSession.id_hash == hash_token(secret)).one_or_none()
  if row is None or status(row) != 'active':
    session.pop('sid', None)
    if row is not None and status(row) in ('expired', 'idle'):
      g.auth_error = ('session_expired', "Your session expired: sign in again.")
    return None
  g.session_row = row
  now = utcnow()
  if now - row.last_seen_at >= LAST_SEEN_EVERY:
    row.last_seen_at = now
    try:
      db_session.commit()
    except Exception as e:
      print(f"[sessions] WARNING: could not update when a session was last seen: {type(e).__name__}")
      db_session.rollback()
  return row


def end():
  """Signs out: revokes the request's session. The caller commits."""
  row = current()
  if row is not None:
    row.revoked_at = utcnow()
  session.pop('sid', None)
  return row


def revoke_all(user_id: int, except_id: Optional[int] = None) -> int:
  """Revokes a user's sessions (added to the database session: the caller commits). Returns how many."""
  from ..models import UserSession
  now = utcnow()
  query = UserSession.query.filter(UserSession.user_id == user_id, UserSession.revoked_at.is_(None), UserSession.expires_at > now)
  if except_id is not None:
    query = query.filter(UserSession.id != except_id)
  return query.update({"revoked_at": now}, synchronize_session=False)


def revoke_provider(user_id: int, provider_id: str) -> int:
  """Revokes the sessions a user started with a provider, e.g. when the IdP refuses their refresh token. The caller commits."""
  from ..models import UserSession
  now = utcnow()
  query = UserSession.query.filter(UserSession.user_id == user_id, UserSession.provider_id == provider_id,
                                   UserSession.revoked_at.is_(None), UserSession.expires_at > now)
  return query.update({"revoked_at": now}, synchronize_session=False)


def upgrades_old_cookie(user) -> bool:
  """
  Whether a cookie from before sessions were stored (flask-login's, SAML's) becomes a stored session: nobody is signed
  out by the upgrade. The server doesn't create these cookies anymore, so they're older than every stored session, and
  flask-login's remember cookie never expires on the server: not if the user's sessions ended since (signed out,
  ended by them or an admin, disabled), it could be a copy, nor after `sessions.max_days` since the upgrade.
  """
  from sqlalchemy import or_, and_, func
  from backend import db_session
  from ..models import UserSession, AuditEvent
  if UserSession.query.filter(UserSession.user_id == user.id, UserSession.revoked_at.isnot(None)).first() is not None:
    return False
  ended = (AuditEvent.query
           .filter(AuditEvent.target_type == 'user', AuditEvent.target_id == str(user.id))
           .filter(or_(AuditEvent.action == 'session.revoke_all',
                       and_(AuditEvent.action == 'user.update', AuditEvent.changes['status']['to'].astext == 'disabled')))
           .first())
  if ended is not None:
    return False
  # the first stored session: about when the server was upgraded
  upgraded_at = db_session.query(func.min(UserSession.created_at)).scalar()
  return upgraded_at is None or utcnow() < upgraded_at + datetime.timedelta(days=setting('sessions.max_days'))


def serialize(row, current_id=None) -> dict:
  return {
    "id": row.id,
    "current": row.id == current_id,
    "provider_id": row.provider_id,
    "created_at": iso(row.created_at),
    "last_seen_at": iso(row.last_seen_at),
    "expires_at": iso(row.expires_at),
    "ip": row.ip,
    "user_agent": row.user_agent,
    "status": status(row),
  }
