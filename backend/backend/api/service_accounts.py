"""
Service accounts and their tokens (backend/service_accounts.py): the instance's, managed by admins in the admin panel,
and the projects', managed by their owners from the project's Access page. Like users' tokens, only browser sessions
create them, and their secret is only returned once.
"""
from flask import request, jsonify, g

from backend import app, db_session
from ..models import User, Token
from ..access import authorize, denied
from ..access.grants import changed
from ..access.grants import AccessError, clean_path
from .. import service_accounts as accounts
from .. import tokens as tokens_lib
from .auth import authenticated, session_required
from .tokens import token_request


def error(message: str, status: int = 400, **extra):
  return jsonify({"error": message, **extra}), status


def may_manage(owner_type: str, project_id):
  """None if the caller can manage the service accounts of the instance (admins) or of the project (owners), else the response"""
  actor = g.actor
  if owner_type == 'project':
    decision = authorize(actor, 'project.access', project_id)
    return None if decision.allowed else denied(decision)
  if not actor.is_admin:
    return error("Only QA-Board admins manage the instance's service accounts. Projects' owners manage theirs, from the project's Access page.", 403, reason="not_admin")
  if not actor.has_scope('admin'):
    return error("This token can't use the admin API: it needs the \"admin\" scope.", 403, reason="missing_scope", required="admin")
  return None


def owner_param(value):
  """(project or None for the instance, None) or (None, the error response)"""
  if value in (None, ''):
    return None, None
  try:
    return clean_path(value), None
  except AccessError as e:
    return None, error(e.message, e.status)


def managed_account(account_id):
  """(account, None) or (None, the error response), if the caller can manage it"""
  user = User.query.filter(User.id == account_id, User.kind == 'service').one_or_none()
  # deleted accounts are disabled
  if user is None or user.status == 'disabled':
    return None, error("This service account doesn't exist.", 404)
  forbidden = may_manage(user.owner_type, user.owner_id)
  if forbidden:
    return None, forbidden
  return user, None


@app.route('/api/v1/service-accounts', methods=['GET'])
@app.route('/api/v1/service-accounts/', methods=['GET'])
@authenticated
def list_service_accounts():
  """?project=group/repo: the project's. Without: the instance's"""
  project_id, response = owner_param(request.args.get('project'))
  if response:
    return response
  owner_type = 'project' if project_id else 'instance'
  if forbidden := may_manage(owner_type, project_id):
    return forbidden
  query = User.query.filter(User.kind == 'service', User.status != 'disabled', User.owner_type == owner_type)
  if project_id:
    query = query.filter(User.owner_id == project_id)
  users = query.order_by(User.user_name).all()
  return jsonify({"service_accounts": [accounts.serialize(u) for u in users]})


@app.route('/api/v1/service-accounts', methods=['POST'])
@app.route('/api/v1/service-accounts/', methods=['POST'])
@session_required
def create_service_account():
  """{name, role, project?, description?}: role is required for a project's, optional for the instance's"""
  body = request.get_json(silent=True) or {}
  project_id, response = owner_param(body.get('project'))
  if response:
    return response
  if forbidden := may_manage('project' if project_id else 'instance', project_id):
    return forbidden
  try:
    user = accounts.create(g.actor, body.get('name'), project_id, body.get('role'), body.get('description'))
  except (accounts.ServiceAccountError, AccessError) as e:
    db_session.rollback()
    return error(e.message, e.status)
  db_session.commit()
  changed()
  return jsonify(accounts.serialize(user, with_tokens=True)), 201


@app.route('/api/v1/service-accounts/<int:account_id>', methods=['GET'])
@app.route('/api/v1/service-accounts/<int:account_id>/', methods=['GET'])
@authenticated
def get_service_account(account_id):
  user, response = managed_account(account_id)
  if response:
    return response
  return jsonify(accounts.serialize(user, with_tokens=True))


@app.route('/api/v1/service-accounts/<int:account_id>', methods=['POST'])
@app.route('/api/v1/service-accounts/<int:account_id>/', methods=['POST'])
@session_required
def update_service_account(account_id):
  """{role}: null removes the role of an instance's service account"""
  user, response = managed_account(account_id)
  if response:
    return response
  body = request.get_json(silent=True) or {}
  if 'role' not in body:
    return error("What changes? Send `role`.")
  try:
    accounts.set_role(g.actor, user, body['role'])
  except (accounts.ServiceAccountError, AccessError) as e:
    db_session.rollback()
    return error(e.message, e.status)
  db_session.commit()
  changed()
  return jsonify(accounts.serialize(user, with_tokens=True))


@app.route('/api/v1/service-accounts/<int:account_id>', methods=['DELETE'])
@app.route('/api/v1/service-accounts/<int:account_id>/', methods=['DELETE'])
@session_required
def delete_service_account(account_id):
  user, response = managed_account(account_id)
  if response:
    return response
  accounts.delete(g.actor, user)
  db_session.commit()
  changed()
  return jsonify({"status": "OK"})


@app.route('/api/v1/service-accounts/<int:account_id>/tokens', methods=['POST'])
@app.route('/api/v1/service-accounts/<int:account_id>/tokens/', methods=['POST'])
@session_required
def create_service_account_token(account_id):
  """Like POST /api/v1/user/tokens. A project's service account's tokens are restricted to the project."""
  user, response = managed_account(account_id)
  if response:
    return response
  body = request.get_json(silent=True) or {}
  project_id = accounts.project_of(user)
  if project_id:
    body = {**body, "projects": [project_id]}
  fields, response = token_request(body, list(accounts.SCOPES))
  if response:
    return response
  token, secret = tokens_lib.mint(user, **fields, kind='service', created_by=g.actor.user)
  db_session.commit()
  return jsonify({**tokens_lib.serialize(token), "token": secret}), 201


@app.route('/api/v1/service-accounts/<int:account_id>/tokens/<int:token_id>', methods=['DELETE'])
@app.route('/api/v1/service-accounts/<int:account_id>/tokens/<int:token_id>/', methods=['DELETE'])
@session_required
def revoke_service_account_token(account_id, token_id):
  user, response = managed_account(account_id)
  if response:
    return response
  token = Token.query.filter(Token.id == token_id, Token.user_id == user.id).one_or_none()
  if token is None:
    return error("This token doesn't exist.", 404)
  tokens_lib.revoke(token, by=g.actor.user)
  db_session.commit()
  return jsonify(tokens_lib.serialize(token))
