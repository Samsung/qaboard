"""
Authentication for qaboard - LOCAL, LDAP and SAML.
"""
import os

import ldap
from flask import request, jsonify, redirect, session
from flask_login import LoginManager, login_user, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
from onelogin.saml2.auth import OneLogin_Saml2_Auth
from onelogin.saml2.utils import OneLogin_Saml2_Utils

from backend import app, db_session
from ..models import User


login_type = os.getenv("QABOARD_LOGIN_TYPE") # LOCAL/LDAP/SAML
if login_type == "LDAP":
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

elif login_type == "SAML":
  # the directory that contains the settings files and certs
  app.config['SAML_PATH'] = os.path.abspath(os.getenv('QABOARD_SAML_DIR'))
  # User attributes
  saml_attr_email = os.environ.get('QABOARD_SAML_ATTRIBUTE_EMAIL')
  saml_attr_user_name = os.environ.get('QABOARD_SAML_ATTRIBUTE_USER_NAME')
  saml_attr_common_name = os.environ.get('QABOARD_SAML_ATTRIBUTE_COMMON_NAME')
  # saml_attr_id = os.environ.get('QABOARD_SAML_ATTRIBUTE_ID')

login_manager = LoginManager(app)


# @app.route('/api/v1/user/signup/', methods=['POST'])
def signup():
  try:
    user = create_user({
      "email": request.form.get('email'),
      "user_name": request.form.get('user_name'),
      "full_name": request.form.get('full_name'),
      "password": request.form.get('password'),
      "is_ldap": False,
      "is_sso": False,
    })
  except Exception as e:
    print(f"[signup] Error when creating new user with {request.form}: {e}")
    return f"ERROR: The email or user name already exists. ({e})", 403
  return jsonify({"id": user.id}) # FIXME: return more info ?


@app.route('/api/v1/user/auth/', methods=['POST'])
def auth_post():
  if current_user.is_authenticated:
    logout_user()
  username = request.form.get('username')
  password = request.form.get('password')
  user_info = auth(username, password)
  if not user_info["login_success"]:
    print(f"[auth] Failed Login @{username}")
    return jsonify({"error": user_info["error"]}), 403

  user = User.query.filter_by(user_name=username).one()
  login_user(user)
  print(f"[auth] Login @{username}")
  return jsonify(user_info)


@app.route('/api/v1/user/me/', methods=['GET'])
def get_current_user(to_jsonify=True):
  if login_type == "SAML":
    info = {
      "is_authenticated": False,
    }
    if 'samlUserdata' in session:
        if len(session['samlUserdata']) > 0:
            samlUserdata = session['samlUserdata']
            user_name = samlUserdata.get(saml_attr_user_name, [])[0]
            # email = samlUserdata.get(saml_attr_email, [])[0]
            # full_name = samlUserdata.get(saml_attr_common_name, [])[0]
            # user_id = samlUserdata.get(saml_attr_id, [])[0]
            user = User.query.filter_by(user_name=user_name).one_or_none()
            info.update({
            "is_authenticated": True,
            "is_ldap": False,
            "is_sso": True,
            "user_id": user.id,
            "user_name": user.user_name,
            "full_name": user.full_name,
            "email": user.email,
      })
  else: # login_type != "SAML"
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
        "is_sso": current_user.is_sso,
      })

  if to_jsonify: return jsonify(info)
  else: return info


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
    is_sso=info["is_sso"],
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
  if login_type == "LDAP" and (not user or user.is_ldap):
    return auth_ldap(username, password)
  # elif login_type == "SAML" and (not user or user.is_sso):
  #   return auth_sso(username, password)
  else:
    return auth_local(username, password)


def auth_local(username, password):
  info = {
    "username": username,
    "is_ldap": False,
    "is_sso": False,
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
  if login_type != "LDAP":
    raise Exception("LDAP authentication is disabled")
  user_info = {
    "user_name": user_name,
    "is_ldap": True,
    "is_sso": False,
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
      user = create_user(user_info)
    user_info["id"] = user.id
  return user_info

@app.route('/api/auth/saml20/login/', methods=['GET', 'POST'])
def saml_auth():
    """ SAML Authentication """
    req = prepare_flask_request(request)
    auth = init_saml_auth(req)
    errors = []


    if 'sso' in request.args:
        return redirect(auth.login(return_to=request.referrer))
        # If AuthNRequest ID need to be stored in order to later validate it, do instead
        # sso_built_url = auth.login()
        # session['AuthNRequestID'] = auth.get_last_request_id()
        # return redirect(sso_built_url)
    elif 'slo' in request.args:
        name_id = session_index = name_id_format = name_id_nq = name_id_spnq = None
        if 'samlNameId' in session:
            name_id = session['samlNameId']
        if 'samlSessionIndex' in session:
            session_index = session['samlSessionIndex']
        if 'samlNameIdFormat' in session:
            name_id_format = session['samlNameIdFormat']
        if 'samlNameIdNameQualifier' in session:
            name_id_nq = session['samlNameIdNameQualifier']
        if 'samlNameIdSPNameQualifier' in session:
            name_id_spnq = session['samlNameIdSPNameQualifier']
        session.clear()
        return redirect(auth.logout(name_id=name_id, session_index=session_index, nq=name_id_nq, name_id_format=name_id_format, spnq=name_id_spnq))
    elif 'acs' in request.args:
        request_id = None
        if 'AuthNRequestID' in session:
            request_id = session['AuthNRequestID']

        auth.process_response(request_id=request_id)
        errors = auth.get_errors()
        not_auth_warn = not auth.is_authenticated()
        if len(errors) == 0:
            if 'AuthNRequestID' in session:
                del session['AuthNRequestID']

            session['samlUserdata'] = auth.get_attributes()
            session['samlNameId'] = auth.get_nameid()
            session['samlNameIdFormat'] = auth.get_nameid_format()
            session['samlNameIdNameQualifier'] = auth.get_nameid_nq()
            session['samlNameIdSPNameQualifier'] = auth.get_nameid_spnq()
            session['samlSessionIndex'] = auth.get_session_index()

            if len(session['samlUserdata']) > 0:
              samlUserdata = session['samlUserdata']
              user_info = {
              "is_ldap": False,
              "is_sso": True,
              "user_name": samlUserdata.get(saml_attr_user_name, [])[0],
              "full_name": samlUserdata.get(saml_attr_common_name, [])[0],
              "email": samlUserdata.get(saml_attr_email, [])[0],
              }
            else: 
              pass # TODO: return error
            # user_info = get_current_user(to_jsonify=False)
            user = User.query.filter_by(user_name=user_info.get("user_name")).one_or_none()
            if not user:
              user = create_user(user_info)

            self_url = OneLogin_Saml2_Utils.get_self_url(req)
            if 'RelayState' in request.form and self_url != request.form['RelayState']:
                # TODO: To avoid 'Open Redirect' attacks, before execute the redirection confirm
                # the value of the request.form['RelayState'] is a trusted URL.
                return redirect(auth.redirect_to(request.form['RelayState']))
    elif 'sls' in request.args:
        request_id = None
        if 'LogoutRequestID' in session:
            request_id = session['LogoutRequestID']
        dscb = lambda: session.clear()
        url = auth.process_slo(request_id=request_id, delete_session_cb=dscb)
        errors = auth.get_errors()
        if len(errors) == 0:
            if url is not None:
                # TODO: To avoid 'Open Redirect' attacks, before execute the redirection confirm
                # the value of the request.form['RelayState'] is a trusted URL.
                return redirect(url)
            # else: # TODO:

    # TODO: handle bad request:
    raise Exception(" ".join(errors))
    # self_url = OneLogin_Saml2_Utils.get_self_url(req)
    # if 'RelayState' in request.form and self_url != request.form['RelayState']:
    #     return redirect(auth.redirect_to(request.form['RelayState']))


def init_saml_auth(req):
    auth = OneLogin_Saml2_Auth(req, custom_base_path=app.config['SAML_PATH'])
    return auth

def prepare_flask_request(request):
    # If server is behind proxys or balancers use the HTTP_X_FORWARDED fields
    return {
        'https': 'on' if request.environ.get('HTTP_X_FORWARDED_PROTO') == 'https' else 'off',
        'http_host': request.environ.get('HTTP_X_FORWARDED_HOST'),
        'server_port': request.environ.get('HTTP_X_FORWARDED_PORT'),
        'script_name': request.path,
        'get_data': request.args.copy(),
        # Uncomment if using ADFS as IdP, https://github.com/onelogin/python-saml/pull/144
        # 'lowercase_urlencoding': True,
        'post_data': request.form.copy()
    }
    # url_data = urlparse(request.url)
    # return {
    #     'https': 'on' if request.scheme == 'https' else 'off',
    #     'http_host': request.host,
    #     'server_port': url_data.port,
    #     'script_name': request.path,
    #     'get_data': request.args.copy(),
    #     # Uncomment if using ADFS as IdP, https://github.com/onelogin/python-saml/pull/144
    #     # 'lowercase_urlencoding': True,
    #     'post_data': request.form.copy()
    # }
