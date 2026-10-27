"""
API tokens: users create, list and revoke theirs. And the OAuth device flow (RFC 8628) of `qa auth login`.
See backend/tokens.py for the tokens themselves, and docs/design/user-management.md (Appendix A).
"""
import os
import secrets
import datetime

from flask import request, jsonify, g

from backend import app, db_session
from ..models import Token, DeviceAuthorization
from ..settings import setting
from ..audit import audit
from .. import tokens as tokens_lib
from .auth import login_required, session_required, authenticated


MAX_NAME_LENGTH = 100


def bad_request(message: str):
  return jsonify({"error": message}), 400


def token_expiry(body: dict):
  """(expires_at, error message) from `expires_in_days`: absent means the default, null means never"""
  max_days = setting('tokens.max_lifetime_days')
  if 'expires_in_days' not in body:
    days = setting('tokens.default_lifetime_days')
    if max_days:
      days = min(days, max_days)
  else:
    days = body['expires_in_days']
    if days is None:
      if max_days:
        return None, f"Tokens must expire on this server: choose at most {max_days} days."
      return None, None
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
      return None, "`expires_in_days` must be a number of days (at least 1), or null for no expiry date."
    if max_days and days > max_days:
      return None, f"Tokens can't last more than {max_days} days on this server."
  return tokens_lib.utcnow() + datetime.timedelta(days=days), None


@app.route('/api/v1/user/tokens', methods=['GET'])
@app.route('/api/v1/user/tokens/', methods=['GET'])
@login_required
def list_tokens():
  user = g.actor.user
  tokens = Token.query.filter(Token.user_id == user.id).order_by(Token.created_at.desc().nullslast(), Token.id.desc()).all()
  return jsonify({"tokens": [tokens_lib.serialize(t) for t in tokens]})


def token_request(body: dict, allowed_scopes):
  """(fields for tokens_lib.mint, None) from a request to create a token, or (None, the error response)"""
  name = body.get('name')
  if not isinstance(name, str) or not name.strip():
    return None, bad_request("Give the token a name, e.g. where you'll use it.")
  if len(name) > MAX_NAME_LENGTH:
    return None, bad_request(f"Token names have at most {MAX_NAME_LENGTH} characters.")
  scopes = body.get('scopes')
  if not isinstance(scopes, list) or not scopes or not all(isinstance(s, str) for s in scopes):
    return None, bad_request(f"Choose the token's scopes, among: {', '.join(allowed_scopes)}.")
  unknown = [s for s in scopes if s not in tokens_lib.SCOPES]
  if unknown:
    return None, bad_request(f"Unknown scopes: {', '.join(unknown)}. Choose among: {', '.join(allowed_scopes)}.")
  refused = [s for s in scopes if s not in allowed_scopes]
  if refused:
    return None, bad_request(f"These tokens can't have the scopes: {', '.join(refused)}. Choose among: {', '.join(allowed_scopes)}.")
  try:
    projects = tokens_lib.clean_project_patterns(body.get('projects'))
  except ValueError as e:
    return None, bad_request(str(e))
  expires_at, error = token_expiry(body)
  if error:
    return None, bad_request(error)
  idle_expiry_days = body.get('idle_expiry_days')
  if idle_expiry_days is not None and (isinstance(idle_expiry_days, bool) or not isinstance(idle_expiry_days, int) or idle_expiry_days < 1):
    return None, bad_request("`idle_expiry_days` must be a number of days (at least 1), or null.")
  return {"name": name.strip(), "scopes": scopes, "projects": projects, "expires_at": expires_at, "idle_expiry_days": idle_expiry_days}, None


@app.route('/api/v1/user/tokens', methods=['POST'])
@app.route('/api/v1/user/tokens/', methods=['POST'])
@session_required
def new_token():
  user = g.actor.user
  body = request.get_json(silent=True) or {}
  if isinstance(body.get('scopes'), list) and 'admin' in body['scopes'] and not g.actor.is_admin:
    return jsonify({"error": "Only admins can create tokens with the \"admin\" scope.", "reason": "not_admin"}), 403
  fields, error = token_request(body, list(tokens_lib.SCOPES))
  if error:
    return error
  token, secret = tokens_lib.mint(user, **fields, created_by=user, kind='personal')
  db_session.commit()
  return jsonify({**tokens_lib.serialize(token), "token": secret}), 201


@app.route('/api/v1/user/token/', methods=['POST'])
@session_required
def create_token():
  """Legacy: a token valid a year, with the scopes tokens had before scopes. Use POST /api/v1/user/tokens instead."""
  user = g.actor.user
  token, secret = tokens_lib.mint(
    user, name="API token", scopes=list(tokens_lib.LEGACY_SCOPES), kind='personal',
    expires_at=tokens_lib.utcnow() + datetime.timedelta(days=365), created_by=user,
  )
  db_session.commit()
  return jsonify({"token": secret, "created_at": tokens_lib.iso(token.created_at), "expires_at": tokens_lib.iso(token.expires_at)})


@app.route('/api/v1/user/tokens/<int:token_id>', methods=['DELETE'])
@app.route('/api/v1/user/tokens/<int:token_id>/', methods=['DELETE'])
@authenticated
def revoke_token(token_id):
  """Users revoke their tokens, whatever the token's scopes. With a token, only itself (`qa auth logout`)."""
  actor = g.actor
  token = Token.query.filter(Token.id == token_id, Token.user_id == actor.user.id).one_or_none()
  if token is None:
    return jsonify({"error": "This token doesn't exist, or isn't yours."}), 404
  if actor.token is not None and actor.token.id != token.id:
    return jsonify({"error": "A token can only revoke itself: revoke other tokens from the web app.", "reason": "session_required"}), 403
  tokens_lib.revoke(token, by=actor.user)
  db_session.commit()
  return jsonify(tokens_lib.serialize(token))


# ==========================================
# Device flow, for `qa auth login`
# ==========================================

DEVICE_CODE_LIFETIME = datetime.timedelta(minutes=15)
POLL_INTERVAL = 5 # seconds
# RFC 8628 §6.1: no vowels (no words), no ambiguous characters
USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'


def normalize_user_code(code) -> str:
  if not isinstance(code, str):
    return ''
  return ''.join(c for c in code.upper() if c in USER_CODE_ALPHABET)


def format_user_code(code: str) -> str:
  return f"{code[:4]}-{code[4:]}"


def public_url() -> str:
  """The web app's URL, as users reach it"""
  if os.environ.get('QABOARD_URL'):
    return os.environ['QABOARD_URL'].rstrip('/')
  scheme = request.headers.get('X-Forwarded-Proto', request.scheme).split(',')[0].strip()
  return f"{scheme}://{request.host}"


def device_status(device, now=None) -> str:
  """pending, approved, denied, expired, or consumed (approved, and the CLI got its token)"""
  now = now or tokens_lib.utcnow()
  if device.status in ('pending', 'approved') and now >= device.expires_at:
    return 'expired'
  return device.status


def oauth_error(error: str, description: str, status=400):
  return jsonify({"error": error, "error_description": description}), status


@app.route('/api/v1/auth/device/code', methods=['POST'])
def device_code():
  body = request.get_json(silent=True) or {}
  client_name = str(body.get('client_name') or 'qa CLI')[:MAX_NAME_LENGTH]
  hostname = body.get('hostname')
  hostname = str(hostname)[:200] if hostname else None
  secret = secrets.token_urlsafe(32)
  now = tokens_lib.utcnow()
  for _ in range(10):
    user_code = ''.join(secrets.choice(USER_CODE_ALPHABET) for _ in range(8))
    taken = DeviceAuthorization.query.filter(
      DeviceAuthorization.user_code == user_code,
      DeviceAuthorization.expires_at > now,
    ).first()
    if not taken:
      break
  from ..audit import client_ip
  device = DeviceAuthorization(
    device_code_hash=tokens_lib.hash_token(secret),
    user_code=user_code,
    client_name=client_name,
    hostname=hostname,
    ip=client_ip(),
    scopes=list(tokens_lib.CLI_SCOPES),
    status='pending',
    created_at=now,
    expires_at=now + DEVICE_CODE_LIFETIME,
  )
  db_session.add(device)
  db_session.commit()
  verification_uri = f"{public_url()}/device"
  return jsonify({
    "device_code": secret,
    "user_code": format_user_code(user_code),
    "verification_uri": verification_uri,
    "verification_uri_complete": f"{verification_uri}?code={format_user_code(user_code)}",
    "expires_in": int(DEVICE_CODE_LIFETIME.total_seconds()),
    "interval": POLL_INTERVAL,
  })


@app.route('/api/v1/auth/device/token', methods=['POST'])
def device_token():
  body = request.get_json(silent=True) or {}
  secret = body.get('device_code')
  if not isinstance(secret, str) or not secret:
    return oauth_error('invalid_request', "Missing device_code.")
  device = DeviceAuthorization.query.filter(DeviceAuthorization.device_code_hash == tokens_lib.hash_token(secret)).with_for_update().one_or_none()
  if device is None:
    return oauth_error('invalid_grant', "Unknown device code: run `qa auth login` again.")
  now = tokens_lib.utcnow()
  status = device_status(device, now)
  if status == 'expired':
    db_session.rollback()
    return oauth_error('expired_token', "The code expired before it was approved: run `qa auth login` again.")
  if status == 'denied':
    db_session.rollback()
    return oauth_error('access_denied', "The request was denied in the web app.")
  if status == 'consumed':
    db_session.rollback()
    return oauth_error('expired_token', "This code was already used: run `qa auth login` again.")
  if status == 'pending':
    too_fast = device.last_polled_at and (now - device.last_polled_at).total_seconds() < POLL_INTERVAL - 1
    device.last_polled_at = now
    db_session.commit()
    if too_fast:
      return oauth_error('slow_down', f"Poll at most every {POLL_INTERVAL} seconds.")
    return oauth_error('authorization_pending', "Waiting for you to approve the request in the web app.")
  # approved: the token is created now, so its secret is never stored
  user = device.user
  if user is None or user.status != 'active':
    db_session.rollback()
    return oauth_error('access_denied', "The account that approved this request can't use QA-Board.")
  name = device.client_name + (f" ({device.hostname})" if device.hostname and device.hostname not in device.client_name else '')
  from ..actor import Actor
  token, token_secret = tokens_lib.mint(
    user, name=name[:MAX_NAME_LENGTH], scopes=device.scopes or list(tokens_lib.CLI_SCOPES), kind='cli',
    idle_expiry_days=setting('tokens.cli_idle_expiry_days'), created_by=user,
    data={"client": device.client_name, "hostname": device.hostname, "ip": device.ip},
    # the user approved it
    actor=Actor(user),
  )
  device.status, device.token_id = 'consumed', token.id
  db_session.commit()
  return jsonify({
    "access_token": token_secret,
    "token_type": "Bearer",
    "token_id": token.id,
    "user_name": user.user_name,
    "scopes": token.scopes,
    "expires_at": tokens_lib.iso(token.expires_at),
    "idle_expiry_days": token.idle_expiry_days,
  })


def find_pending_device(code):
  user_code = normalize_user_code(code)
  if len(user_code) != 8:
    return None
  return (DeviceAuthorization.query
          .filter(DeviceAuthorization.user_code == user_code)
          .order_by(DeviceAuthorization.created_at.desc())
          .first())


def serialize_device(device) -> dict:
  return {
    "user_code": format_user_code(device.user_code),
    "client_name": device.client_name,
    "hostname": device.hostname,
    "ip": device.ip,
    "scopes": device.scopes or [],
    "created_at": tokens_lib.iso(device.created_at),
    "expires_at": tokens_lib.iso(device.expires_at),
    # for people, the CLI having received its token is a detail
    "status": 'approved' if device_status(device) == 'consumed' else device_status(device),
  }


@app.route('/api/v1/auth/device', methods=['GET'])
@app.route('/api/v1/auth/device/', methods=['GET'])
@session_required
def get_device():
  device = find_pending_device(request.args.get('code'))
  if device is None:
    return jsonify({"error": "This code is unknown: check it, or run `qa auth login` again to get a new one."}), 404
  return jsonify(serialize_device(device))


@app.route('/api/v1/auth/device', methods=['POST'])
@app.route('/api/v1/auth/device/', methods=['POST'])
@session_required
def approve_device():
  body = request.get_json(silent=True) or {}
  device = find_pending_device(body.get('code'))
  if device is None:
    return jsonify({"error": "This code is unknown: check it, or run `qa auth login` again to get a new one."}), 404
  status = device_status(device)
  if status != 'pending':
    messages = {
      'expired': "This code expired: run `qa auth login` again to get a new one.",
      'approved': "This request was already approved.",
      'consumed': "This request was already approved.",
      'denied': "This request was denied.",
    }
    return jsonify({"error": messages[status], "status": status}), 409
  user = g.actor.user
  approve = body.get('approve') is True
  device.status = 'approved' if approve else 'denied'
  device.user_id = user.id
  audit('device.approve' if approve else 'device.deny', 'device', device.id, device.client_name, meta={
    "hostname": device.hostname, "ip": device.ip, "scopes": device.scopes,
  })
  db_session.commit()
  return jsonify({"status": device.status})
