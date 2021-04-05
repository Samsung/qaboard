"""
Authentication for qaboard users and LDAP.
"""
import os

import ldap
from flask import request, jsonify
from flask_login import LoginManager, login_user, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash

from backend import app, db_session
from ..models import User


ldap_enabled = os.getenv('QABOARD_LDAP_ENABLED') 
if ldap_enabled:
  # Server hostname (including port)
  ldap_host = os.environ['QABOARD_LDAP_HOST']
  # Server port, usually 389 or 636 if SSL is used.
  ldap_port = os.environ.get('QABOARD_LDAP_PORT', 389)
  # Search base for users. (Will not be searched recursively)
  ldap_user_base = os.environ['QABOARD_LDAP_USER_BASE']
  # The Distinguished Name to bind as, this user will be used to lookup information about other users.
  ldap_bind_dn = os.environ['QABOARD_LDAP_BIND_DN']
  # The password to bind with for the lookup user.
  ldap_password = os.environ['QABOARD_LDAP_PASSWORD']
  # "User lookup filter, the placeholder {login} will be replaced by the user supplied login. (e.g. `(&(objectClass=inetOrgPerson)(|(uid={login})(mail={login})))`, or `(&(objectClass=user)(|(sAMAccountName={login})))`)
  ldap_user_filter = os.environ['QABOARD_LDAP_USER_FILTER']
  # User attributes
  ldap_attr_email = os.environ.get('QABOARD_LDAP_ATTRIBUTE_EMAIL', "mail")
  ldap_attr_common_name = os.environ.get('QABOARD_LDAP_ATTRIBUTE_COMMON_NAME', "cn")


login_manager = LoginManager(app)


@app.route('/api/v1/user/signup/', methods=['POST'])
def signup():
  try:
    create_user({
      "email": request.form.get('email'),
      "user_name": request.form.get('user_name'),
      "password": request.form.get('password'),
    })
  except Exception as e:
    print(f"[signup] Error when creating new user with {request.form}: {e}")
    return f"ERROR: The email or user name already exists", 403
  return jsonify({"id": new_user.id}) # FIXME: return more info ?


@app.route('/api/v1/user/auth/', methods=['POST'])
def auth_post():
  if current_user.is_authenticated:
    logout_user()
  username = request.form['username']
  password = request.form['password']
  user_info = auth(username, password)
  if not user_info["login_success"]:
    print(f"[auth] Failed Login @{username}")
    return jsonify({"error": user_info["error"]}), 403

  user = User.query.filter_by(user_name=username).one()
  login_user(user)
  print(f"[auth] Login @{username}")
  return jsonify(user_info)


@app.route('/api/v1/user/me/', methods=['GET'])
def get_current_user():
  # https://flask-login.readthedocs.io/en/latest/#your-user-class
  is_authenticated = current_user.is_authenticated
  info = {
    "is_authenticated": is_authenticated,
    "is_anonymous": current_user.is_anonymous,
    "is_active": current_user.is_active,
  }
  if is_authenticated:
    info.update({
      "user_id": current_user.id,
      "user_name": current_user.user_name,
      "full_name": current_user.full_name,
      "email": current_user.email,
      "is_ldap": current_user.is_ldap,
    })
  return jsonify(info)


@app.route('/api/v1/user/logout/', methods=['POST'])
def logout():
  if current_user.is_authenticated:
    logout_user()
  return jsonify({"status": "OK"})


@login_manager.user_loader
def load_user(user_id):
  return User.query.get(user_id)

def create_user(info):
  user = User(
    user_name=info["user_name"],
    full_name=info["full_name"],
    email=info["email"],
    is_ldap=info["is_ldap"],
    # TODO: use a slower hash, currently the default is pbkdf2:sha256
    # https://werkzeug.palletsprojects.com/en/1.0.x/utils/#werkzeug.security.generate_password_hash
    password= generate_password_hash(info["password"]) if "password" in info else None,
  )
  db_session.add(user)
  db_session.commit()
  print(f"Created {user}")
  return user


def auth(username, password):
  user = User.query.filter_by(user_name=username).first() # if this returns a user, then the user_name already exists in database
  # FIXME: check we render the error field in JS, not invalid_passord=True..
  if ldap_enabled and (not user or user.is_ldap):
    return auth_ldap(username, password)
  else:
    return auth_local(username, password)


def auth_local(username, password):
  info = {
    "username": username,
    "is_ldap": False,
    "login_success": False,
  }
  user = User.query.filter_by(user_name=username).one_or_none()
  if not user:
    info["error"] = "invalid-username"
  elif not check_password_hash(user.password, password):
    info["error"] = "invalid-password"
  else:
    info["login_success"] = True
    info["id"] = user.id
    info["full_name"] = user.full_name
    info["user_name"] = user.user_name
    info["email"] = user.email
  return info

def auth_ldap(user_name, password):
  if not ldap_enabled:
    raise Exception("LDAP is not enabled")
  user_info = {
    "user_name": user_name,
    "is_ldap": True,
    "login_success": False,
  }
  # TODO: support for secure LDAP
  ldap_uri = f"ldap://{ldap_host}" if not ldap_port else f"ldap://{ldap_host}:{ldap_port}"
  ldap_connect = ldap.initialize(ldap_uri)
  ldap_connect.set_option(ldap.OPT_REFERRALS, 0)
  ldap_connect.simple_bind_s(ldap_bind_dn, ldap_password)

  # check if the user exists
  ldap_search = ldap_user_filter.replace("{login}", user_name)
  certificate = ldap_connect.search_s(
    ldap_user_base,
    ldap.SCOPE_SUBTREE, 
    ldap_search, 
    ['distinguishedName'],
  )[0][0]

  if certificate:
    # check the password and get the full user info
    try:
      ldap_connect.set_option(ldap.OPT_REFERRALS, 0)
      ldap_connect.simple_bind_s(certificate, password) 
      details = ldap_connect.search_s(
        ldap_user_base,
        ldap.SCOPE_SUBTREE, 
        ldap_search,
        [ldap_attr_common_name, 'mail'],
      )
      user_ldap = details[0][1]
      user_info["login_success"] = True
      user_info["full_name"] = str(user_ldap[ldap_attr_common_name][0], 'utf-8')
      user_info["email"] = str(user_ldap[ldap_attr_email][0], 'utf-8')
    except (ldap.INVALID_CREDENTIALS, ldap.OPERATIONS_ERROR):
      user_info["error"] = "invalid-password"
  else:
    user_info["error"] = "invalid-username"
  ldap_connect.unbind_s()

  if user_info["login_success"]:
    user = User.query.filter_by(user_name=user_name).one_or_none()
    if not user:
      create_user(user_info)
    user_info["id"] = user.id
  return user_info

