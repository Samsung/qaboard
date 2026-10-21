"""
The admin panel's Sign-in section: providers (OIDC ones can be added here), their tests, access requests and sessions.
"""
from flask import request, jsonify, g

from backend import app, db_session
from ..audit import audit, diff
from ..tokens import utcnow
from ..sign_in import providers as providers_lib, doctor, sessions
from ..sign_in.crypto import can_encrypt, encrypt, NoEncryptionKey
from ..sign_in.access import serialize as serialize_request
from .auth import admin_required
from .sign_in import callback_url
from .tokens import public_url


MATCH_USERS = ('none', 'username', 'email')
CLAIMS = tuple(providers_lib.DEFAULT_CLAIMS)


@app.route('/api/v1/admin/sign-in', methods=['GET'])
@app.route('/api/v1/admin/sign-in/', methods=['GET'])
@admin_required
def admin_sign_in():
  return jsonify({
    "providers": [{**p.describe(), **({"redirect_uri": callback_url(p)} if p.type == 'oidc' else {})} for p in providers_lib.all_providers()],
    "can_encrypt": can_encrypt(),
    "public_url": public_url(),
  })


def provider_fields(body: dict, existing=None):
  """(fields, error) from the admin panel's form"""
  config = dict(existing.config) if existing else {}
  for key in ('issuer', 'client_id'):
    if key in body:
      if not isinstance(body[key], str) or not body[key].strip():
        return None, f"{key} can't be empty"
      config[key] = body[key].strip()
  if not config.get('issuer', '').startswith(('https://', 'http://')):
    return None, "The issuer is a URL, e.g. https://keycloak.example.com/realms/company"
  if not config.get('client_id'):
    return None, "Set the client id the IdP gave you."
  if 'scopes' in body:
    scopes = body['scopes'] if isinstance(body['scopes'], list) else str(body['scopes']).replace(',', ' ').split()
    if 'openid' not in scopes:
      return None, "The scopes must include openid."
    config['scopes'] = scopes
  if 'claims' in body:
    if not isinstance(body['claims'], dict) or any(k not in CLAIMS or not isinstance(v, str) for k, v in body['claims'].items()):
      return None, f"claims maps {', '.join(CLAIMS)} to claim names"
    config['claims'] = {k: v.strip() for k, v in body['claims'].items() if v.strip()}
  if 'match_users' in body:
    if body['match_users'] not in MATCH_USERS:
      return None, f"match_users is one of {', '.join(MATCH_USERS)}"
    config['match_users'] = body['match_users']
  for key in ('client_secret_env', 'redirect_uri'):
    if key in body:
      config[key] = (body[key] or '').strip() or None
  if 'recommended' in body:
    config['recommended'] = bool(body['recommended'])
  fields = {"config": {k: v for k, v in config.items() if v is not None}}
  if 'name' in body:
    fields['name'] = str(body['name']).strip()[:100]
  if 'enabled' in body:
    fields['enabled'] = bool(body['enabled'])
  if 'position' in body:
    try:
      fields['position'] = int(body['position'])
    except (TypeError, ValueError):
      return None, "position is a number"
  if body.get('client_secret'):
    try:
      fields['secret_encrypted'] = encrypt(body['client_secret'])
    except NoEncryptionKey as e:
      return None, str(e)
  return fields, None


def describe_row(row):
  provider = providers_lib.get(row.id)
  return {**provider.describe(), "redirect_uri": callback_url(provider)}


@app.route('/api/v1/admin/sign-in/providers', methods=['POST'])
@app.route('/api/v1/admin/sign-in/providers/', methods=['POST'])
@admin_required
def admin_create_provider():
  from ..models import AuthProvider
  body = request.get_json(silent=True) or {}
  provider_id = body.get('id')
  if not providers_lib.valid_id(provider_id):
    return jsonify({"error": "The id goes in URLs: lowercase letters, digits, - and _, e.g. keycloak. Not local, ldap, saml or sso."}), 400
  if AuthProvider.query.filter(AuthProvider.id == provider_id).one_or_none():
    return jsonify({"error": f"There is already a provider {provider_id}."}), 409
  fields, error = provider_fields(body)
  if error:
    return jsonify({"error": error}), 400
  row = AuthProvider(id=provider_id, type='oidc', name=fields.pop('name', provider_id) or provider_id, created_at=utcnow(), updated_at=utcnow(), **fields)
  db_session.add(row)
  audit('provider.create', 'provider', row.id, row.name, meta={"config": row.config})
  db_session.commit()
  return jsonify(describe_row(row)), 201


@app.route('/api/v1/admin/sign-in/providers/<provider_id>', methods=['POST', 'DELETE'])
@app.route('/api/v1/admin/sign-in/providers/<provider_id>/', methods=['POST', 'DELETE'])
@admin_required
def admin_update_provider(provider_id):
  from ..models import AuthProvider
  row = AuthProvider.query.filter(AuthProvider.id == provider_id).one_or_none()
  if row is None:
    env = providers_lib.get(provider_id)
    if env is not None:
      return jsonify({"error": f"{env.name} is set up in the server's environment: change it there."}), 400
    return jsonify({"error": "This provider doesn't exist."}), 404
  if request.method == 'DELETE':
    db_session.delete(row)
    audit('provider.delete', 'provider', row.id, row.name)
    db_session.commit()
    return jsonify({"status": "OK"})
  body = request.get_json(silent=True) or {}
  fields, error = provider_fields(body, existing=row)
  if error:
    return jsonify({"error": error}), 400
  before = {"name": row.name, "enabled": row.enabled, "position": row.position, "config": row.config}
  for key, value in fields.items():
    setattr(row, key, value)
  row.updated_at = utcnow()
  after = {"name": row.name, "enabled": row.enabled, "position": row.position, "config": row.config}
  audit('provider.update', 'provider', row.id, row.name, changes=diff(before, after), meta={"secret_changed": 'secret_encrypted' in fields})
  db_session.commit()
  return jsonify(describe_row(row))


@app.route('/api/v1/admin/sign-in/providers/<provider_id>/test', methods=['POST'])
@app.route('/api/v1/admin/sign-in/providers/<provider_id>/test/', methods=['POST'])
@admin_required
def admin_test_provider(provider_id):
  provider = providers_lib.get(provider_id)
  if provider is None:
    return jsonify({"error": "This provider doesn't exist."}), 404
  body = request.get_json(silent=True) or {}
  if provider.type == 'oidc':
    checks = doctor.check_oidc(provider, callback_url(provider))
  elif provider.type == 'ldap':
    checks = doctor.check_ldap(body.get('user_name'))
  else:
    checks = [doctor.check("configuration", True, f"{provider.name} has no automatic checks: try signing in")]
  return jsonify({"checks": checks, "ok": all(c["ok"] for c in checks)})


@app.route('/api/v1/admin/access-requests', methods=['GET'])
@app.route('/api/v1/admin/access-requests/', methods=['GET'])
@admin_required
def admin_access_requests():
  from ..models import AccessRequest
  status = request.args.get('status', 'pending')
  query = AccessRequest.query
  if status != 'all':
    query = query.filter(AccessRequest.status == status)
  rows = query.order_by(AccessRequest.created_at.desc()).limit(200).all()
  return jsonify({"requests": [serialize_request(r) for r in rows]})


@app.route('/api/v1/admin/users/<int:user_id>/revoke-sessions', methods=['POST'])
@app.route('/api/v1/admin/users/<int:user_id>/revoke-sessions/', methods=['POST'])
@admin_required
def admin_revoke_user_sessions(user_id):
  from ..models import User
  user = User.query.filter(User.id == user_id).one_or_none()
  if user is None:
    return jsonify({"error": "This user doesn't exist."}), 404
  current = g.get('session_row')
  count = sessions.revoke_all(user.id, except_id=current.id if current is not None and user.id == g.actor.user.id else None)
  audit('session.revoke_all', 'user', user.id, user.user_name, meta={"revoked": count})
  db_session.commit()
  return jsonify({"revoked": count})
