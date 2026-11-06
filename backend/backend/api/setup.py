"""
The setup page of a new server (/setup in the web app): whoever has the setup token creates the first admin.
See backend/first_admin.py.
"""
from flask import request, jsonify

from backend import app, db_session
from ..audit import audit
from .. import first_admin


@app.route('/api/v1/setup', methods=['GET'])
@app.route('/api/v1/setup/', methods=['GET'])
def setup_status():
  return jsonify({
    "open": first_admin.setup_open(),
    "default_user_name": first_admin.DEFAULT_ADMIN_USER,
    "min_password_length": first_admin.MIN_PASSWORD_LENGTH,
  })


@app.route('/api/v1/setup', methods=['POST'])
@app.route('/api/v1/setup/', methods=['POST'])
def setup_first_admin():
  """{token, user_name, password, full_name?, email?}: creates the first admin, and signs them in"""
  body = request.get_json(silent=True) or {}
  if not first_admin.setup_open():
    return jsonify({"error": "QA-Board is already set up: sign in, or ask an admin for an account.", "reason": "setup_done"}), 409
  if not first_admin.check_setup_token(body.get('token')):
    # never the token they sent: it's a secret, maybe a typo of the real one
    audit('setup.token_rejected', meta={"user_name": str(body.get('user_name') or '')[:100]})
    db_session.commit()
    return jsonify({"error": "This isn't the setup token. Copy it from the server's logs, or run `qaboard-admin setup-token` on the server.", "reason": "invalid_setup_token", "field": "token"}), 403

  user_name = body.get('user_name')
  user_name = user_name.strip() if isinstance(user_name, str) else user_name
  email = (body.get('email') or '').strip() or None
  full_name = (body.get('full_name') or '').strip() or None
  password = body.get('password')
  from sqlalchemy import text
  # two people setting up at once: only one becomes the first admin
  db_session.execute(text("SELECT pg_advisory_xact_lock(hashtext('qaboard-first-admin'))"))
  if not first_admin.setup_open():
    db_session.rollback()
    return jsonify({"error": "Someone just set up QA-Board: sign in, or ask them for an account.", "reason": "setup_done"}), 409
  for field, problem in [('user_name', first_admin.user_name_problem(user_name)), ('email', first_admin.email_problem(email)),
                         ('password', first_admin.password_problem(password))]:
    if problem:
      db_session.rollback()
      return jsonify({"error": problem, "reason": "invalid", "field": field}), 400

  user = first_admin.new_local_user(user_name, password, full_name=full_name, email=email, is_admin=True)
  audit('setup.first_admin', 'user', user.id, user.user_name, user=user, meta={"login_type": "LOCAL"})
  db_session.commit()
  print(f"[setup] {user.user_name} set up QA-Board: they're its first admin", flush=True)

  from ..sign_in.accounts import finish as finish_sign_in
  from ..admins import is_admin
  finish_sign_in(user, 'local')
  return jsonify({
    "user_id": user.id,
    "user_name": user.user_name,
    "full_name": user.full_name,
    "email": user.email,
    "status": user.status,
    "is_admin": is_admin(user),
  }), 201
