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

login_manager = LoginManager(app)

############################## HTTP Requests ##################################

@app.route('/api/v1/user/signup/', methods=['POST'])
def signup_post():
  email = request.form.get('email')
  name = request.form.get('username')
  password = request.form.get('password')

  # create a new user with the form data. Hash the password so the plaintext version isn't saved.
  new_user = signup_db(email=email, user_name=name, password=password)
  if not new_user:
    print("signup_post: Email address or User Name already exists:", name, email)
    return f"403 Email address or User Name already exists", 403
  return jsonify({"status": "OK", "id": new_user.id})


@app.route('/api/v1/user/auth/', methods=['POST'])
def auth_post():
  '''Login method'''
  invalid_username = False
  invalid_password = False

  if current_user.is_authenticated:
    logout_user()
  if not request.form.get('username') or not request.form.get('password'):
    return jsonify({'error': 'Wrong user name or password.',
                        'invalid_username': invalid_username,
                        'invalid_password': invalid_password}), 403

  username = request.form.get('username')
  password = request.form.get('password')
  res = auth(username, password)
  if not res["login_success"]:
    print("auth_post: Login Failed:", username)
    return jsonify({'error': 'Wrong user name or password.', 
                    'invalid_username': res["invalid_username"], 
                    'invalid_password': res["invalid_password"]}), 403

  user_db = User.query.filter_by(user_name=username).first() # if this returns a user, then the user_name already exists in database
  login_user(user_db)
  print("auth_post: Login success:", username)
  return jsonify({"status": "OK", "full_name": res["full_name"], "user_name": res["user_name"]})


@app.route('/api/v1/user/get-auth/', methods=['GET'])
def get_authenticated_user_post():
  if current_user.is_authenticated:
    return jsonify({
      "status": "OK",
      "is_authenticated": current_user.is_authenticated,
      "is_anonymous": current_user.is_anonymous,
      "is_active": current_user.is_active,
      "user_id": current_user.id,
      "user_name": current_user.user_name,
      "full_name": current_user.full_name,
      "email": current_user.email,
      "is_ldap": current_user.is_ldap
      })

  # No authenticated user found -> will return "is_authenticated": false
  return jsonify({
    "status": "OK",
    "is_authenticated": current_user.is_authenticated,
    "is_anonymous": current_user.is_anonymous,
    "is_active": current_user.is_active,
    })


@app.route('/api/v1/user/logout/', methods=['POST'])
def logout_post():
  if current_user.is_authenticated:
    logout_user()
  return jsonify({"status": "OK"})

################################ Methods ######################################

@login_manager.user_loader
def load_user(user_id):
  return User.query.get(user_id)


def signup_db(user_name, full_name, email, is_ldap, password=None):
  user_db = User.query.filter_by(user_name=user_name).first() # if this returns a user, then the user_name already exists in database

  if not user_db: # create a new user.
    if password: # Hash the password (for non-ldap) so the plaintext version isn't saved.
      password = generate_password_hash(password, method='sha256')
    new_user = User(user_name=user_name, full_name=full_name, email=email, is_ldap=is_ldap, password=password)
    # add the new user to the database
    db_session.add(new_user)
    db_session.commit()
    print("signup_db: Created new user:", new_user)
    return new_user

  return False


def auth(username, password):
  user_db = User.query.filter_by(user_name=username).first() # if this returns a user, then the user_name already exists in database
  is_ldap = os.getenv('QA_LDAP_ENABLED', '')

  if is_ldap and (not user_db or user_db.is_ldap):
    res = ldap_auth(username, password)
  else:
    res = local_auth(username, password)
  return res


def local_auth(username, password):
  res = {
    "login_success": True,
    "full_name": "",
    "user_name": "",
    "mail": "",
    "invalid_password": False,
    "invalid_username": False,
    "is_ldap": False,
  }

  user_db = User.query.filter_by(user_name=username).first()
  # check if the user actually exists
  if not user_db:
    res["invalid_username"] = True
    res["invalid_password"] = True
    res["login_success"] = False
    # print("Username does not exist:", username)

  # take the user-supplied password, hash it, and compare it to the hashed password in the database
  elif not check_password_hash(user_db.password, password):
    res["invalid_password"] = True
    res["login_success"] = False
    # print("Invalid Password")

  else:
    # if the above check passes, then we know the user has the right credentials
    res["full_name"] = f"{user_db.full_name}" if user_db.full_name else None
    res["user_name"] = f"{user_db.user_name}"
    res["mail"] = f"{user_db.email}"

  return res


def ldap_auth(username, password):
  res = {
    "login_success": True, 
    "full_name": "",
    "user_name": "",
    "mail": "",
    "invalid_password": False,
    "invalid_username": False,
    "is_ldap": True,
  }
  ldap_server = os.getenv('QA_LDAP_HOST', '')
  ldap_distinguished_name = str(os.getenv('QA_LDAP_USER', ''))
  ldap_password = os.getenv('QA_LDAP_PASSWORD', '')
  ldap_connect = ldap.initialize(ldap_server)
  ldap_connect.set_option(ldap.OPT_REFERRALS, 0)
  ldap_connect.simple_bind_s(ldap_distinguished_name, ldap_password)
  # check if the user exists
  certificate = ldap_connect.search_s(
    "dc=transchip,dc=com",
    ldap.SCOPE_SUBTREE, 
    f"uid={username}", 
    ['distinguishedName'],
  )[0][0]

  if certificate:
    # check the password and get the full user info
    try:
      ldap_connect.set_option(ldap.OPT_REFERRALS, 0)
      ldap_connect.simple_bind_s(certificate, password) 
      details = ldap_connect.search_s(
        "dc=transchip,dc=com",
        ldap.SCOPE_SUBTREE, 
        f"uid={username}", 
        ['cn', 'mail'],
      )

      res["full_name"] = str(details[0][1]["cn"][0], 'utf-8')
      res["mail"] = str(details[0][1]["mail"][0], 'utf-8')
      res["user_name"] = str(username)
    except ldap.INVALID_CREDENTIALS:
      # print("Invalid Password")
      res["login_success"] = False
      res["invalid_password"] = True
  else:
    # print("Username does not exist!")
    res["login_success"] = False
    res["invalid_username"] = True
  ldap_connect.unbind_s()

  if res["login_success"]:
    # if user doesn't exists in the database, add it.
    signup_db(user_name=username, full_name=res["full_name"], email=res["mail"], is_ldap=res["is_ldap"])

  return res

