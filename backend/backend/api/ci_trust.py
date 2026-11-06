"""
CI jobs without stored secrets (backend/ci_trust.py): service accounts list the CI jobs they trust, and those jobs
exchange their OIDC ID token for a short-lived token of the account.
"""
from flask import request, jsonify, g

from backend import app, db_session
from .. import ci_trust
from .. import service_accounts as accounts
from .auth import session_required
from .service_accounts import managed_account, error
from .tokens import public_url


@app.route('/api/v1/service-accounts/<int:account_id>/ci-trust', methods=['POST'])
@app.route('/api/v1/service-accounts/<int:account_id>/ci-trust/', methods=['POST'])
@session_required
def create_ci_trust(account_id):
  """{provider: github|gitlab|other, issuer?, audience?, repository, ref?, environment?, conditions?}: the account"""
  user, response = managed_account(account_id)
  if response:
    return response
  body = request.get_json(silent=True) or {}
  try:
    ci_trust.add_policy(g.actor, user, body, public_url())
  except ci_trust.CiTrustError as e:
    db_session.rollback()
    return error(e.message, e.status)
  db_session.commit()
  return jsonify(accounts.serialize(user, with_tokens=True)), 201


@app.route('/api/v1/service-accounts/<int:account_id>/ci-trust/<policy_id>', methods=['DELETE'])
@app.route('/api/v1/service-accounts/<int:account_id>/ci-trust/<policy_id>/', methods=['DELETE'])
@session_required
def delete_ci_trust(account_id, policy_id):
  user, response = managed_account(account_id)
  if response:
    return response
  if not ci_trust.remove_policy(g.actor, user, policy_id):
    return error("It doesn't trust these CI jobs anymore.", 404)
  db_session.commit()
  return jsonify(accounts.serialize(user, with_tokens=True))


def oauth_error(e: ci_trust.CiTrustError):
  # admins debug refusals from the log: the token itself is never written
  print(f"[ci-trust] refused a token exchange ({e.status}): {e.message}{f' ({e.detail})' if e.detail else ''}")
  return jsonify({"error": e.code, "error_description": e.message}), e.status


@app.route('/api/v1/auth/token-exchange', methods=['POST'])
@app.route('/api/v1/auth/token-exchange/', methods=['POST'])
def token_exchange():
  """
  RFC 8693: {grant_type, subject_token (the CI job's ID token), subject_token_type, service_account? (a hint)}, as a
  form or JSON => {access_token, issued_token_type, token_type, expires_in, service_account}
  """
  body = request.get_json(silent=True) if request.is_json else request.form
  body = body if hasattr(body, 'get') else {}
  if body.get('grant_type') != ci_trust.GRANT_TYPE:
    return oauth_error(ci_trust.CiTrustError(f"grant_type must be {ci_trust.GRANT_TYPE}.", 400, 'unsupported_grant_type'))
  if body.get('subject_token_type', ci_trust.SUBJECT_TOKEN_TYPES[0]) not in ci_trust.SUBJECT_TOKEN_TYPES:
    return oauth_error(ci_trust.CiTrustError(f"subject_token_type must be {' or '.join(ci_trust.SUBJECT_TOKEN_TYPES)}.", 400, 'invalid_request'))
  hint = body.get('service_account')
  try:
    account, token, secret = ci_trust.exchange(body.get('subject_token'), hint if isinstance(hint, str) and hint.strip() else None)
  except ci_trust.CiTrustError as e:
    db_session.rollback()
    return oauth_error(e)
  db_session.commit()
  return jsonify({
    "access_token": secret,
    "issued_token_type": ci_trust.ISSUED_TOKEN_TYPE,
    "token_type": "Bearer",
    "expires_in": round((token.expires_at - token.created_at).total_seconds()),
    "service_account": account.user_name,
    "scopes": token.scopes,
    "projects": token.projects,
  })
