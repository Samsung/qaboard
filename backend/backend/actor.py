"""
Who is calling: resolved once per request, before the endpoints run, as `flask.g.actor`.

- A bearer token (`Authorization: Bearer qab_pat_…`) wins. A token that can't be used is refused with a 401 that
  says why, in every mode: silently ignoring a broken credential would hide the problem.
  `?token=` is only accepted for GET requests (URLs end up in access logs).
- Else the session cookie (flask-login, or the SAML session).
- Else nobody.

Token requests never open a session. With `auth.require_sign_in`, anonymous API requests get a 401, except
the endpoints in PUBLIC_ENDPOINTS. Writes authenticated by cookies must come from our own origin (CSRF).
The endpoints then check what the actor may do (api/auth.py: login_required, admin_required...).
"""
import os
import datetime
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from flask import request, g, jsonify, session
from flask.sessions import SecureCookieSessionInterface

from .settings import setting
from . import tokens as tokens_lib


# How often we save when a token was last used
LAST_USED_EVERY = datetime.timedelta(minutes=5)

# Endpoints anonymous users can call when the server requires signing in
PUBLIC_ENDPOINTS = {
  'get_site_config', 'health',
  # signing in
  'get_current_user', 'auth_post', 'signup', 'logout', 'saml_auth', 'device_code', 'device_token',
  'sign_in_providers', 'oidc_start', 'oidc_callback', 'my_access_request',
  # nginx asks it whether users may read files, it answers 401 itself
  'authorize_files',
}
# The `qa` CLI sends results there: open unless ingest.auth is "token"
INGEST_ENDPOINTS = {
  ('new_output_webhook', 'POST'), ('update_batch', 'POST'), ('api_ci_commit', 'POST'),
}
SAFE_METHODS = {'GET', 'HEAD', 'OPTIONS'}


@dataclass
class Actor:
  user: Optional[object] = None
  token: Optional[object] = None
  # who acts without a user, in the audit log, e.g. "qaboard-admin"
  label: Optional[str] = None

  @property
  def via(self) -> str:
    if self.token is not None:
      return 'token'
    return 'session' if self.user is not None else 'anonymous'

  @property
  def is_authenticated(self) -> bool:
    return self.user is not None

  @property
  def is_admin(self) -> bool:
    from .admins import is_admin
    return self.user is not None and is_admin(self.user)

  def has_scope(self, scope: str) -> bool:
    """Sessions can do everything their user can, tokens only what their scopes say"""
    if self.user is None:
      return False
    if self.token is None:
      return True
    return scope in tokens_lib.scopes_of(self.token)

  def allows_project(self, project_id: Optional[str]) -> bool:
    """Tokens can be restricted to some projects"""
    if self.token is None:
      return True
    return tokens_lib.matches_project(self.token.projects or [], project_id)

  def submitted_by(self) -> Optional[dict]:
    """Who really sent results, saved with runs, batches and commits"""
    if self.user is None:
      return None
    info = {"user_id": self.user.id, "user_name": self.user.user_name, "via": self.via}
    if self.token is not None:
      info.update(token_id=self.token.id, token_name=self.token.name)
    return info


def error(status: int, reason: str, message: str, **extra):
  return jsonify({"error": message, "reason": reason, **extra}), status


# Sentences say what's wrong: the CLI and the web app add what to do, where they know the context (CI, a browser...)
SIGN_IN_REQUIRED = ('sign_in_required', "Sign in to do this.")
USER_ERRORS = {
  'disabled': ('user_disabled', "This account is disabled. Ask a QA-Board admin if you need it back."),
  'pending': ('user_pending', "This account is waiting for an admin's approval."),
}


def token_error(token, token_status: str):
  if token_status == 'revoked':
    return 'token_revoked', "This token was revoked."
  if token_status == 'expired':
    return 'token_expired', f"This token expired on {token.expires_at:%Y-%m-%d}."
  return 'token_idle_expired', f"This token expired after {token.idle_expiry_days} days without use."


def unauthenticated():
  """The 401 of requests without a usable user: why, if we know (e.g. a disabled account)"""
  reason, message = g.get('auth_error') or SIGN_IN_REQUIRED
  return error(401, reason, message)


def bearer_token() -> Optional[str]:
  header = request.headers.get('Authorization', '')
  if header.lower().startswith('bearer '):
    return header[7:].strip()
  return None


def resolve_token(token_str: str):
  """(token, None) or (None, error response)"""
  from .models import Token
  if not tokens_lib.is_well_formed(token_str):
    return None, error(401, 'token_invalid', "This token is not valid.")
  token = Token.query.filter(Token.token_hash == tokens_lib.hash_token(token_str)).one_or_none()
  if token is None:
    return None, error(401, 'token_invalid', "This token is unknown: it was deleted, or it's mistyped.")
  token_status = tokens_lib.status(token)
  if token_status != 'active':
    return None, error(401, *token_error(token, token_status))
  user = token.user
  if user is None or user.status in USER_ERRORS:
    return None, error(401, *USER_ERRORS[user.status if user else 'disabled'])
  return token, None


def touch(token):
  """Saves when and from where tokens were used, at most every few minutes per token"""
  from backend import db_session
  from .audit import audit, client_ip
  now = datetime.datetime.utcnow()
  ip = client_ip()
  # /user/me says when the token was used before this request
  g.token_previous_use = token.last_used_at
  # not on every IP change either: tokens shared by many CI runners change IPs all the time
  if token.last_used_at and now - token.last_used_at < LAST_USED_EVERY:
    return
  if token.last_used_ip and ip and token.last_used_ip != ip:
    audit('token.new_ip', 'token', token.id, token.name, meta={"previous_ip": token.last_used_ip}, actor=Actor(token.user, token))
  token.last_used_at, token.last_used_ip = now, ip
  try:
    db_session.commit()
  except Exception as e:
    # e.g. a concurrent update: the next request will try again
    print(f"[auth] WARNING: could not update when {token} was last used: {type(e).__name__}")
    db_session.rollback()


def session_user():
  """The user of the request's session (backend/sign_in/sessions.py)"""
  from .sign_in import sessions
  row = sessions.current()
  if row is not None:
    return row.user
  if 'sid' in session or g.get('auth_error'):
    return None
  # Sessions opened before sessions were stored (flask-login's cookies, SAML's): they become stored sessions, nobody
  # is signed out by the upgrade. Unless they could be copies (sessions.upgrades_old_cookie)
  user = None
  if session.get('_user_id') or request.cookies.get('remember_token'):
    from flask_login import current_user
    candidate = current_user._get_current_object() if current_user else None
    if candidate is not None and not getattr(candidate, 'is_anonymous', True):
      user = candidate
  elif 'samlUserdata' in session:
    from .api.auth import saml_session_user
    user = saml_session_user()
  if user is None:
    return None
  from flask_login import logout_user
  from backend import db_session
  # the browser forgets the old cookies either way
  logout_user()
  if not sessions.upgrades_old_cookie(user):
    session.pop('samlUserdata', None)
    g.auth_error = ('session_expired', "Your session expired: sign in again.")
    return None
  sessions.start(user, (user.login_type or 'local').lower())
  db_session.commit()
  return user


def own_origins() -> set:
  hosts = {request.host.split(':')[0]}
  for forwarded in request.headers.get('X-Forwarded-Host', '').split(','):
    if forwarded.strip():
      hosts.add(forwarded.strip().split(':')[0])
  qaboard_url = os.environ.get('QABOARD_URL')
  if qaboard_url:
    hosts.add(urlparse(qaboard_url).hostname or '')
  for origin in setting('auth.allowed_origins') or []:
    hosts.add(urlparse(origin).hostname or origin)
  return {h.lower() for h in hosts if h}


def is_cross_site() -> bool:
  origin = request.headers.get('Origin') or request.headers.get('Referer')
  if not origin or origin == 'null':
    # not from a browser, or a browser that hides it: SameSite=Lax cookies already protect these
    return origin == 'null'
  return (urlparse(origin).hostname or '').lower() not in own_origins()


def is_same_origin() -> bool:
  """
  Whether the browser says the request comes from our pages, for the GETs that change things (cookies come with
  other websites' links). Unlike is_cross_site, nothing said means no.
  """
  if request.headers.get('Sec-Fetch-Site'):
    return request.headers['Sec-Fetch-Site'] == 'same-origin'
  # older browsers
  origin = request.headers.get('Origin') or request.headers.get('Referer')
  return bool(origin) and origin != 'null' and (urlparse(origin).hostname or '').lower() in own_origins()


def is_public_endpoint() -> bool:
  if request.endpoint in PUBLIC_ENDPOINTS:
    return True
  if (request.endpoint, request.method) in INGEST_ENDPOINTS:
    return setting('ingest.auth') != 'token'
  return False


def resolve_actor():
  g.actor = Actor()
  # only the API: /s/ and /webhook/ check access themselves
  is_api = request.path.startswith('/api/')
  token_str = bearer_token()
  if token_str is None and request.method in SAFE_METHODS:
    token_str = request.args.get('token') or None
  elif token_str is None and request.args.get('token') and is_api:
    return error(401, 'token_in_url', "Tokens in URLs are only accepted to read: send it in the Authorization header.")
  if token_str is not None:
    token, response = resolve_token(token_str)
    if response is not None:
      return response
    g.actor = Actor(token.user, token)
    touch(token)
  else:
    user = session_user()
    if user is not None:
      if user.status == 'disabled':
        from .sign_in import sessions
        from backend import db_session
        sessions.end()
        db_session.commit()
        g.auth_error = USER_ERRORS[user.status]
      elif user.status == 'pending':
        # they keep their session: they see that they wait for an admin, and can say why they need access
        g.pending_user = user
        g.auth_error = USER_ERRORS[user.status]
      else:
        g.actor = Actor(user)

  if not is_api or request.method == 'OPTIONS':
    return None
  if g.actor.via == 'session' and request.method not in SAFE_METHODS and is_cross_site():
    return error(403, 'cross_site_write', "This change was sent from another website: QA-Board refused it. If it's expected, ask an admin to add it to auth.allowed_origins.")
  if g.actor.user is None and setting('auth.require_sign_in') and not is_public_endpoint():
    return unauthenticated()
  if g.actor.token is not None and request.method in SAFE_METHODS and not g.actor.has_scope('read') and request.endpoint != 'get_current_user':
    return error(403, 'missing_scope', "This token can't read: it needs the \"read\" scope.", required='read')
  return None


class SessionInterface(SecureCookieSessionInterface):
  """Token requests never open sessions"""
  def should_set_cookie(self, app, session):
    actor = g.get('actor')
    if actor is not None and actor.token is not None:
      return False
    return super().should_set_cookie(app, session)


def after_request(response):
  warning = g.get('qaboard_warning')
  if warning:
    response.headers['X-QABoard-Warning'] = warning
  return response


def register(app):
  app.session_interface = SessionInterface()
  app.before_request(resolve_actor)
  app.after_request(after_request)
