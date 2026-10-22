"""
Signing in with the providers of backend/sign_in/: the sign-in page's options, OIDC's redirects, pending users' requests,
and what users see of their sessions and sign-in methods. The password form posts to /api/v1/user/auth/ (api/auth.py).
"""
from urllib.parse import urlencode

from flask import request, jsonify, redirect, g, session

from backend import app, db_session
from ..settings import setting
from ..audit import audit
from ..sign_in import providers as providers_lib, sessions, identities, oidc
from ..sign_in.oidc import SignInError
from ..sign_in.accounts import finish as finish_sign_in, oidc_account
from ..sign_in.access import request_access, serialize as serialize_request
from ..access.groups import groups_overage
from .auth import login_required, session_required, safe_redirect_url, is_login_restricted, is_authorized_user, ldap_lookup, update_user, login_type
from .tokens import public_url


@app.route('/api/v1/auth/providers', methods=['GET'])
@app.route('/api/v1/auth/providers/', methods=['GET'])
def sign_in_providers():
  next_url = safe_redirect_url(request.args.get('next')) if request.args.get('next') else None
  options = providers_lib.sign_in_options(show_local=request.args.get('local') in ('1', 'true'))
  redirects = [p for p in options if p.kind == 'redirect']
  return jsonify({
    "providers": [p.public(next_url) for p in options],
    "password_form": any(p.kind == 'password' for p in options),
    "local_signup": setting('auth.local_signup'),
    # go straight to the only single sign-on
    "auto_redirect": bool(setting('auth.sso_auto_redirect') and setting('auth.require_sign_in') and len(redirects) == 1 and request.args.get('local') not in ('1', 'true')),
  })


def callback_url(provider):
  return oidc.redirect_uri(provider, public_url())


def oidc_provider(provider_id):
  provider = providers_lib.get(provider_id)
  if provider is None or provider.type != 'oidc' or not provider.enabled:
    raise SignInError('sso_unavailable', f"There is no enabled OIDC provider {provider_id!r}")
  return provider


def to_login_page(code: str, ref=None, provider_id=None):
  return redirect(f"/login?{urlencode({'error': code, **({'ref': ref} if ref else {}), **({'provider': provider_id} if provider_id else {})})}")


@app.route('/api/v1/auth/oidc/<provider_id>/start', methods=['GET'])
def oidc_start(provider_id):
  """?next=<page> to go back to it. ?link=1 adds this sign-in method to the signed-in user's account."""
  link = request.args.get('link') in ('1', 'true')
  if link and (g.actor.user is None or g.actor.token is not None):
    return to_login_page('sign_in_required')
  try:
    provider = oidc_provider(provider_id)
    next_url = safe_redirect_url(request.args.get('next')) if request.args.get('next') else ('/settings/sign-in' if link else '/')
    return redirect(oidc.authorization_url(provider, callback_url(provider), next_url, link=link))
  except SignInError as e:
    event = audit('auth.login_failed', 'provider', provider_id, provider_id, meta={"provider": provider_id, "reason": e.code, "detail": e.detail})
    db_session.commit()
    print(f"[sign-in] {provider_id}: {e.code}: {e.detail}")
    return to_login_page(e.code, event.id, provider_id)


@app.route('/api/v1/auth/oidc/callback', methods=['GET'])
@app.route('/api/v1/auth/oidc/<provider_id>/callback', methods=['GET'])
def oidc_callback(provider_id=None):
  """The IdP sends users back here (`provider_id` can be omitted for the environment's provider: one URI to register)"""
  provider_id = provider_id or providers_lib.ENV_OIDC_ID
  saved = None
  try:
    saved = oidc.handshake(provider_id, request.args.get('state'))
    provider = oidc_provider(provider_id)
    if request.args.get('error'):
      raise SignInError('sso_failed', f"The IdP answered {request.args['error']}: {request.args.get('error_description', '')}")
    if not request.args.get('code'):
      raise SignInError('sso_failed', "The IdP sent no code")
    claims, refresh_token = oidc.exchange_code(provider, request.args['code'], saved)
    # kept to refresh the groups daily, if the provider does
    refresh_token = refresh_token if provider.config.get('refresh_groups') else None
    linking_user = g.actor.user if saved.get('link') and g.actor.token is None else None
    user, email = oidc_account(provider, claims, linking_user=linking_user)
    if user.status == 'disabled':
      raise SignInError('user_disabled', f"{user.user_name} is disabled")
    groups = claims.get(provider.claim('groups'))
    if linking_user is not None:
      identities.record(user, provider.id, claims['sub'], email=email, claims=claims, refresh_token=refresh_token)
      audit('identity.link', 'user', user.id, user.user_name, meta={"provider": provider.id})
      db_session.commit()
      return redirect(safe_redirect_url(saved.get('next')))
    # the directory's attributes of accounts matched by user name (QABOARD_LOGIN_RESTRICTED_YAML's rules read them)
    if login_type == "LDAP" and (provider.config.get('match_users') or '') == 'username':
      try:
        info = ldap_lookup(user.user_name)
        if info:
          update_user(user, {**info, "login_type": user.login_type or "LDAP"})
      except Exception as e:
        print(f"[sign-in] WARNING: could not look up {user.user_name} in LDAP: {type(e).__name__}")
    if is_login_restricted and not is_authorized_user({"user_name": user.user_name, "email": user.email, "data": user.data}):
      raise SignInError('not_allowed', f"{user.user_name} isn't allowed by the login rules of QABOARD_LOGIN_RESTRICTED_YAML")
    overage = groups_overage(claims)
    if overage:
      print(f"[sign-in] WARNING: {provider.id} sent no groups for {user.user_name}: they're in too many groups (Entra ID's overage). Send only the application's groups.")
    finish_sign_in(user, provider.id, subject=claims['sub'], email=email, claims=claims, refresh_token=refresh_token,
                   **({"idp_groups": groups} if isinstance(groups, list) else {}), **({"groups_overage": True} if overage else {}))
    if user.status == 'pending':
      # the sign-in page shows them their request
      next_url = safe_redirect_url(saved.get('next'))
      return redirect(f"/login?{urlencode({'next': next_url})}" if next_url != '/' else '/login')
    return redirect(safe_redirect_url(saved.get('next')))
  except SignInError as e:
    db_session.rollback()
    event = audit('auth.login_failed', 'provider', provider_id, provider_id, meta={"provider": provider_id, "reason": e.code, "detail": e.detail})
    db_session.commit()
    print(f"[sign-in] {provider_id}: {e.code}: {e.detail}")
    if saved and saved.get('link'):
      return redirect(f"/settings/sign-in?{urlencode({'error': e.code, 'ref': event.id, 'provider': provider_id})}")
    return to_login_page(e.code, event.id, provider_id)


@app.route('/api/v1/user/access-request', methods=['POST'])
@app.route('/api/v1/user/access-request/', methods=['POST'])
def my_access_request():
  """Users waiting for an admin say why they need access"""
  user = g.get('pending_user')
  if user is None:
    if g.actor.user is not None:
      return jsonify({"error": "Your account is already active."}), 400
    return jsonify({"error": "Sign in to do this.", "reason": "sign_in_required"}), 401
  body = request.get_json(silent=True) or {}
  message = body.get('message')
  if not isinstance(message, str) or not message.strip():
    return jsonify({"error": "Say why you need access, e.g. your team and your projects."}), 400
  request_row = request_access(user, message.strip())
  audit('access_request.update', 'user', user.id, user.user_name, user=user)
  db_session.commit()
  return jsonify(serialize_request(request_row))


@app.route('/api/v1/user/sessions', methods=['GET'])
@app.route('/api/v1/user/sessions/', methods=['GET'])
@login_required
def my_sessions():
  from ..models import UserSession
  rows = UserSession.query.filter(UserSession.user_id == g.actor.user.id).order_by(UserSession.last_seen_at.desc()).limit(100).all()
  current = g.get('session_row')
  return jsonify({"sessions": [sessions.serialize(r, current.id if current else None) for r in rows if sessions.status(r) == 'active']})


@app.route('/api/v1/user/sessions', methods=['DELETE'])
@app.route('/api/v1/user/sessions/', methods=['DELETE'])
@session_required
def revoke_my_other_sessions():
  """Signs out everywhere else"""
  current = g.get('session_row')
  count = sessions.revoke_all(g.actor.user.id, except_id=current.id if current is not None else None)
  audit('session.revoke_all', 'user', g.actor.user.id, g.actor.user.user_name, meta={"revoked": count, "kept_current": current is not None})
  db_session.commit()
  return jsonify({"revoked": count})


@app.route('/api/v1/user/sessions/<int:session_id>', methods=['DELETE'])
@app.route('/api/v1/user/sessions/<int:session_id>/', methods=['DELETE'])
@session_required
def revoke_my_session(session_id):
  from ..models import UserSession
  from ..tokens import utcnow
  row = UserSession.query.filter(UserSession.id == session_id, UserSession.user_id == g.actor.user.id).one_or_none()
  if row is None:
    return jsonify({"error": "This session doesn't exist, or isn't yours."}), 404
  row.revoked_at = row.revoked_at or utcnow()
  audit('session.revoke', 'session', row.id, row.user_agent, meta={"ip": row.ip})
  db_session.commit()
  current = g.get('session_row')
  if current is not None and current.id == row.id:
    session.pop('sid', None)
  return jsonify(sessions.serialize(row, current.id if current else None))


@app.route('/api/v1/user/identities', methods=['GET'])
@app.route('/api/v1/user/identities/', methods=['GET'])
@login_required
def my_identities():
  from ..models import UserIdentity
  by_id = {p.id: p for p in providers_lib.all_providers()}
  rows = UserIdentity.query.filter(UserIdentity.user_id == g.actor.user.id).order_by(UserIdentity.id).all()
  linkable = [p.public() for p in by_id.values() if p.type == 'oidc' and p.enabled and not any(r.provider_id == p.id for r in rows)]
  return jsonify({"identities": [identities.serialize(r, by_id) for r in rows], "linkable": linkable})


@app.route('/api/v1/user/identities/<int:identity_id>', methods=['DELETE'])
@app.route('/api/v1/user/identities/<int:identity_id>/', methods=['DELETE'])
@session_required
def unlink_my_identity(identity_id):
  from ..models import UserIdentity
  user = g.actor.user
  rows = UserIdentity.query.filter(UserIdentity.user_id == user.id).all()
  row = next((r for r in rows if r.id == identity_id), None)
  if row is None:
    return jsonify({"error": "This sign-in method doesn't exist, or isn't yours."}), 404
  if len(rows) == 1:
    return jsonify({"error": "It's your only way to sign in: add another one first."}), 400
  db_session.delete(row)
  audit('identity.unlink', 'user', user.id, user.user_name, meta={"provider": row.provider_id})
  db_session.commit()
  return jsonify({"status": "OK"})
