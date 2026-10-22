"""
Authentication for qaboard - LOCAL, LDAP and SAML.
"""
import os
from functools import wraps

import yaml
import ldap
import ldap.filter
import simplejson
from flask import request, jsonify, redirect, session, g, has_request_context
from flask_login import LoginManager, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
try:
  # FIXME: Unfortunately we run often into libxml mismatch version issues
  from onelogin.saml2.auth import OneLogin_Saml2_Auth
except Exception as e:
  print(f"WARNING: Could not import onelogin.saml2: {e}")
from backend import app, db_session
from ..models import User
from ..settings import setting
from ..audit import audit
from ..admins import is_admin
from ..actor import unauthenticated
from ..sign_in import sessions
from ..sign_in.accounts import finish as finish_sign_in, new_user_status
from .. import tokens as tokens_lib
from ..access import can


login_manager = LoginManager(app)

def env_flag(name: str) -> bool:
  """
  Whether a boolean environment variable is set: "false", "0", "no", "off" or empty mean False,
  any other value (e.g. "true", "True", "1") means True.
  """
  return os.getenv(name, "").strip().lower() not in ("", "0", "false", "no", "off")

is_login_restricted = env_flag("QABOARD_LOGIN_RESTRICTED")
if is_login_restricted:
  users_restrict_yaml = os.getenv("QABOARD_LOGIN_RESTRICTED_YAML")
  try:
    with open(users_restrict_yaml, 'r') as f:
      users_restrict_config = yaml.load(f, Loader=yaml.SafeLoader)
  except:
    users_restrict_config = {}
else:
  users_restrict_config = {}

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
  # What group rules can read (Admin → Groups), e.g. memberOf,department
  ldap_group_attributes = [a.strip() for a in os.environ.get('QABOARD_LDAP_GROUP_ATTRIBUTES', 'memberOf').split(',') if a.strip()]

elif login_type == "SAML":
  # the directory that contains the settings files and certs
  app.config['SAML_PATH'] = os.path.abspath(os.getenv('QABOARD_SAML_DIR'))
  # User attributes
  saml_attr_email = os.environ.get('QABOARD_SAML_ATTRIBUTE_EMAIL')
  saml_attr_user_name = os.environ.get('QABOARD_SAML_ATTRIBUTE_USER_NAME')
  saml_attr_common_name = os.environ.get('QABOARD_SAML_ATTRIBUTE_COMMON_NAME')
  # saml_attr_id = os.environ.get('QABOARD_SAML_ATTRIBUTE_ID')


# Don't add the user's info: with LDAP and SAML it holds everything the directory knows about them
not_authorized_error = "The user is not authorized, please contact QA-Board admins."

# FIXME: Today User.data is a bunch of LDAP info stuffed directly.
#        Needs to be namespaced under "ldap". 


@app.route('/api/v1/user/signup/', methods=['POST'])
def signup():
  if not setting('auth.local_signup'):
    return jsonify({"error": "Signing up is disabled on this server: sign in with your usual account, or ask an admin.", "reason": "signup_disabled"}), 403
  user_name = request.form.get('user_name')
  if not user_name or not request.form.get('password'):
    return jsonify({"error": "Both user_name and password are required"}), 400
  # "ALICE" next to "alice" would be confusing, and look like an admin from $QABOARD_ADMINS
  from ..search import escape_like
  if User.query.filter(User.user_name.ilike(escape_like(user_name), escape='\\')).first():
    return jsonify({"error": "This user name is already taken"}), 409
  # admins whatever the database says: they sign in with the directory, or get an account from `qaboard-admin create-admin`
  from ..admins import env_admins
  if user_name.casefold() in {a.casefold() for a in env_admins()}:
    return jsonify({"error": "This user name is reserved: sign in with your usual account, or ask an admin."}), 409
  # Never log or return the form or the exception: they contain the password, its hash, or the SQL query
  try:
    user = create_user({
      "email": request.form.get('email'),
      "user_name": user_name,
      "full_name": request.form.get('full_name'),
      "password": request.form.get('password'),
      "login_type": "LOCAL",
      "data": {},
    })
  except Exception as e:
    db_session.rollback()
    print(f"[signup] Error when creating new user @{user_name}: {type(e).__name__}")
    if type(e).__name__ == "IntegrityError": # sqlalchemy.exc, e.g. the email is already used
      return jsonify({"error": "This user name or email is already used"}), 409
    return jsonify({"error": "Could not create the user"}), 500
  audit('auth.signup', 'user', user.id, user.user_name, user=user)
  db_session.commit()
  return jsonify({
    "id": user.id,
    "email": user.email,
    "user_name": user.user_name,
    "full_name": user.full_name,
    "login_type": user.login_type,
  })


# What users see when they can't sign in. We don't say whether the user name exists.
LOGIN_ERRORS = {
  "invalid-username": "Wrong user name or password.",
  "invalid-password": "Wrong user name or password.",
  "disabled": "This account is disabled. Ask a QA-Board admin if you need it back.",
  "pending": "This account is waiting for an admin's approval.",
}

@app.route('/api/v1/user/auth/', methods=['POST'])
def auth_post():
  if current_user.is_authenticated:
    logout_user()
  username = request.form.get('username')
  password = request.form.get('password')
  # LDAP servers can treat a bind with an empty password as an anonymous bind, that succeeds
  if not username or not password:
    return jsonify({"error": "Enter your user name and your password.", "reason": "invalid_credentials"}), 403
  user_info = auth(username, password)
  user = User.query.filter_by(user_name=username).one_or_none() if user_info["login_success"] else None
  if user_info["login_success"]:
    if user is None:
      user_info = {"login_success": False, "error": "invalid-username"}
    elif user.status == 'disabled':
      user_info = {"login_success": False, "error": user.status}
  if not user_info["login_success"]:
    print(f"[auth] Failed Login @{username}")
    error = user_info.get("error")
    # linked to the account if it exists, so its owner sees the attempts
    known = user or User.query.filter_by(user_name=username).one_or_none()
    audit('auth.login_failed', 'user', known.id if known else None, username, meta={"reason": error, "login_type": login_type or "LOCAL"})
    db_session.commit()
    if error in ("disabled", "pending"):
      reason = f"user_{error}"
    elif error in LOGIN_ERRORS or not error:
      reason = "invalid_credentials"
    else:
      reason = "not_allowed"
    return jsonify({"error": LOGIN_ERRORS.get(error) or error or LOGIN_ERRORS["invalid-password"], "reason": reason}), 403

  provider_id = 'ldap' if (user.login_type or '').upper() == 'LDAP' else 'local'
  finish_sign_in(user, provider_id)
  print(f"[auth] Login @{username}")
  # not user_info's data: with LDAP it holds everything the directory knows about the user
  return jsonify({**{k: v for k, v in user_info.items() if k != 'data'}, "status": user.status, "is_admin": is_admin(user), "user_id": user.id})


@app.route('/api/v1/user/me/', methods=['GET'])
def get_current_user(to_jsonify=True):
  """
  Who is calling (see backend/actor.py). With a token, also which one: its scopes and projects.
  """
  actor = g.get('actor')
  user = actor.user if actor is not None else (current_user if current_user and current_user.is_authenticated else None)
  info = {
    "is_authenticated": user is not None,
    "is_anonymous": user is None,
    "is_active": user is not None,
  }
  if user is None:
    auth_error = g.get('auth_error')
    if auth_error:
      info["reason"], info["error"] = auth_error
    pending_user = g.get('pending_user')
    if pending_user is not None and to_jsonify:
      # what the "waiting for an admin" page shows
      from ..sign_in.access import pending_request, reviewers, serialize as serialize_request
      request_row = pending_request(pending_user)
      info["pending"] = {
        "user_name": pending_user.user_name,
        "full_name": pending_user.full_name,
        "email": pending_user.email,
        "request": serialize_request(request_row) if request_row else None,
        "reviewers": [u.full_name or u.user_name for u in reviewers()][:5],
      }
  else:
    info.update({
      "user_id": user.id,
      "user_name": user.user_name,
      "full_name": user.full_name,
      "email": user.email,
      "login_type": user.login_type,
      "kind": getattr(user, 'kind', 'human'),
      "status": getattr(user, 'status', 'active'),
      "is_admin": is_admin(user),
    })
    if login_type == "SAML" and to_jsonify is False:
      # the SAML attributes are used by the restrictions of QABOARD_LOGIN_RESTRICTED_YAML. Never sent to clients.
      # Not LDAP's: it's a list of [dn, attributes] that matches_rules can't read (they're checked at login).
      info["data"] = user.data
    if actor is not None and actor.token is not None:
      token = actor.token
      info["token"] = {
        "id": token.id,
        "name": token.name,
        "prefix": token.prefix,
        "kind": token.kind,
        "scopes": tokens_lib.scopes_of(token),
        "projects": token.projects or [],
        "expires_at": tokens_lib.iso(token.expires_at),
        "idle_expiry_days": token.idle_expiry_days,
        # before this request
        "last_used_at": tokens_lib.iso(g.get('token_previous_use', token.last_used_at)),
      }
  if to_jsonify:
    return jsonify(info)
  else:
    return info


def saml_session_user():
  """The user of a SAML session opened before SAML sign-ins were also flask-login sessions"""
  if login_type != "SAML":
    return None
  user_data = session.get('samlUserdata') or {}
  user_name = (user_data.get(saml_attr_user_name) or [None])[0]
  if not user_name:
    return None
  return User.query.filter_by(user_name=user_name).one_or_none()


def login_required(f):
  """
  Decorator for endpoints that need a logged-in user (session cookie, SAML session or API token).
  The user's info is available as `flask.g.user` (see get_current_user).
  With a token, writes need the "act" scope, and the token must allow `?project=`.
  With `?project=`, the user must be able to see it. Endpoints that change a project check more with
  require_project_access (e.g. runs.act), on the project of the object they load.
  """
  @wraps(f)
  def wrapper(*args, **kwargs):
    user_info = get_current_user(to_jsonify=False)
    if not user_info.get('is_authenticated') or not user_info.get('user_name'):
      return unauthenticated()
    project = request.args.get('project')
    actor = g.get('actor')
    if actor is not None and actor.token is not None:
      scope = 'read' if request.method in ('GET', 'HEAD') else 'act'
      if not actor.has_scope(scope):
        return jsonify({"error": f"This token can't do this: it needs the \"{scope}\" scope.", "reason": "missing_scope", "required": scope}), 403
      if project and not actor.allows_project(project):
        return jsonify({"error": f"This token can't access {project}.", "reason": "token_project"}), 403
    if project:
      if forbidden := require_project_access(user_info, project, 'project.read'):
        return forbidden
    elif is_login_restricted and not is_authorized_user(user_info, None):
      return forbidden_project(None)
    g.user = user_info
    return f(*args, **kwargs)
  return wrapper


def authenticated(f):
  """Endpoints that need a user, whatever the credential and its scopes: they check what they allow themselves"""
  @wraps(f)
  def wrapper(*args, **kwargs):
    actor = g.get('actor')
    if actor is None or actor.user is None:
      return unauthenticated()
    g.user = get_current_user(to_jsonify=False)
    return f(*args, **kwargs)
  return wrapper


def session_required(f):
  """
  For actions that create credentials (tokens, device approvals): a token can't create tokens,
  else one leaked token could keep minting new ones after it's revoked.
  """
  @wraps(f)
  def wrapper(*args, **kwargs):
    actor = g.get('actor')
    if actor is None or actor.user is None:
      return unauthenticated()
    if actor.token is not None:
      return jsonify({"error": "Do this from the web app: tokens can't create tokens.", "reason": "session_required"}), 403
    g.user = get_current_user(to_jsonify=False)
    return f(*args, **kwargs)
  return wrapper


def admin_required(f):
  """Admin endpoints: an admin's session, or a token of an admin with the "admin" scope"""
  @wraps(f)
  def wrapper(*args, **kwargs):
    actor = g.get('actor')
    if actor is None or actor.user is None:
      return unauthenticated()
    if not actor.is_admin:
      return jsonify({"error": "Only QA-Board admins can do this.", "reason": "not_admin"}), 403
    if not actor.has_scope('admin'):
      return jsonify({"error": "This token can't use the admin API: it needs the \"admin\" scope.", "reason": "missing_scope", "required": "admin"}), 403
    g.user = get_current_user(to_jsonify=False)
    return f(*args, **kwargs)
  return wrapper


def require_project_access(user_info: dict, project_id: str, permission: str = 'runs.act'):
  """
  None if the current user (or token) has the permission on the project (backend/access/policy.py), else the
  response to return: 401 to sign in, 403 with whom to ask.
  Endpoints that change a batch, run or commit must check the project of the object they loaded:
  `login_required` only checks the `?project=` the client chose.
  `user_info` is unused: the check is always about who is calling (g.actor).
  """
  from ..access import authorize, denied
  decision = authorize(g.get('actor') if has_request_context() else None, permission, project_id)
  return None if decision.allowed else denied(decision)


def forbidden_project(project_id=None, permission: str = 'project.read'):
  """The response for a project the current user can't see (or act on), e.g. after is_authorized_user"""
  if project_id and (forbidden := require_project_access(None, project_id, permission)):
    return forbidden
  return jsonify({"error": "Forbidden: You don't have permission to access this project", "reason": "forbidden_project"}), 403


def ingest_access(project_id: str):
  """
  For the endpoints where `qa` sends results: (submitted_by, None) or (None, an error response).
  `submitted_by` says who really sent them (a token's user), None for unverified results.
  With ingest.auth "off" or "warn" we accept unverified results, and the X-QABoard-Warning header tells the CLI why.
  """
  mode = setting('ingest.auth')
  actor = g.get('actor')
  if actor is None or actor.user is None:
    if mode == 'token':
      return None, (jsonify({
        "error": "This server only accepts results sent with a token.",
        "reason": "ingest_token_required",
      }), 403)
    if mode == 'warn':
      g.qaboard_warning = "Your results were saved as unverified, without a token. This server will soon require one: run `qa auth login`, or set QABOARD_TOKEN in CI."
    return None, None
  problem = None
  if not actor.has_scope('ingest'):
    problem = ("missing_scope", "This token can't send results: it needs the \"ingest\" scope.")
  elif not actor.allows_project(project_id):
    problem = ("token_project", f"This token can't send results to {project_id}.")
  elif not can('runs.ingest', project_id, actor):
    problem = ("missing_role", f"You need the developer role to send results to {project_id}.")
  if problem:
    reason, message = problem
    if mode == 'token':
      return None, (jsonify({"error": message, "reason": reason, **({"required": "ingest"} if reason == "missing_scope" else {})}), 403)
    g.qaboard_warning = f"{message} Your results were saved as unverified."
    return None, None
  return actor.submitted_by(), None


@app.route('/api/v1/user/logout/', methods=['POST'])
def logout():
  actor = g.get('actor')
  if actor is not None and actor.user is not None and actor.token is None:
    audit('auth.logout', 'user', actor.user.id, actor.user.user_name)
    db_session.commit()
  sessions.end()
  db_session.commit()
  if current_user.is_authenticated:
    logout_user()
  session.pop('samlUserdata', None)
  return jsonify({"status": "OK"})


@login_manager.user_loader
def load_user(user_id):
  return User.query.get(user_id)


def create_user(info):
  if not info["user_name"]:
    raise Exception("ERROR: cannot create a new user, missing user_name\n")

  user = User(
    user_name=info["user_name"],
    full_name=info["full_name"],
    email=info["email"],
    login_type=info["login_type"],
    # is_ldap=info["is_ldap"],
    # is_sso=info["is_sso"],
    data=info["data"],
    # TODO: use a slower hash, currently the default is pbkdf2:sha256
    # https://werkzeug.palletsprojects.com/en/1.0.x/utils/#werkzeug.security.generate_password_hash
    password=generate_password_hash(info["password"]) if "password" in info else None,
    # active, or waiting for an admin (auth.access_policy)
    status=new_user_status(info.get("email"), verified=info["login_type"] != "LOCAL"),
  )
  db_session.add(user)
  db_session.commit()
  print(f"[auth] Created the user @{user.user_name}" + (" (waiting for an admin)" if user.status == 'pending' else ""))
  return user


def update_user(user, info):
  if not info["user_name"]:
    raise Exception("ERROR: cannot create a new user, missing user_name\n")

  user_info = {
    "user_name":info["user_name"],
    "full_name":info["full_name"],
    "email":info["email"],
    "login_type":info["login_type"],
    "data":info["data"],
    "password": generate_password_hash(info["password"]) if "password" in info else None,
  }
  user.update(**user_info)
  db_session.add(user)
  db_session.commit()
  return user


def restrictions(section: str) -> dict:
  """
  The rules of a section of QABOARD_LOGIN_RESTRICTED_YAML: "login", "projects" or "paths".
  Empty if QABOARD_LOGIN_RESTRICTED is not set.
  """
  return users_restrict_config.get(section) or {}


def restricted_project_key(project: str):
  """
  The key of QABOARD_LOGIN_RESTRICTED_YAML's "projects" that applies to a project:
  the project itself, else the longest key the project starts with (e.g. its namespace).
  None if the project is public.
  """
  projects = restrictions('projects')
  if project in projects:
    return project
  matching_keys = [key for key in projects if project.startswith(key)]
  if not matching_keys:
    return None
  return max(matching_keys, key=len)


def matches_rules(user_info: dict, perms_data: dict) -> bool:
  """
  Whether the user matches one of the rules from QABOARD_LOGIN_RESTRICTED_YAML,
  e.g. {"user_name": ["john.doe"], "email": [...], "data": {"<SAML/LDAP attribute>": [...]}}.
  """
  is_authorized = False
  for key, value in user_info.items():
    if is_authorized: break
    if key in perms_data.keys():
      if isinstance(value, str):
        is_authorized = value in perms_data[key]
      elif isinstance(value, list):
        is_authorized = any([v for v in value if v in perms_data[key]])
      elif isinstance(value, dict):
          for inner_key, inner_value in value.items():
            if is_authorized: break
            if inner_key in perms_data[key].keys():
              is_authorized = any([v for v in inner_value if v in perms_data[key][inner_key]])
  return is_authorized


def is_authorized_user(user_info: dict, project=None):
  """
  Check if the given user is authorized to access the server or to a specified project.

  This function determines if a user is authorized by verifying their information 
  and optionally checking their access rights to a particular project. If no
  `user_info` is provided, the current user's information is retrieved and used.

  Args:
      user_info (dict): A dictionary containing information about the user.
      project (optional): The project to check authorization for.
                          If `None`, the function only checks general user authorization to the server.

  Returns:
      bool: True if the user is authorized to access the project (or authorized in general 
            if no project is provided), False otherwise.
  """
  if project:
    # the current user (or token) can see it: backend/access/
    return can('project.read', project)
  if not user_info:
    user_info = get_current_user(to_jsonify=False)
  perms_data = restrictions('login')
  if not perms_data:
    return True
  return matches_rules(user_info, perms_data)


def auth(username, password):
  user = User.query.filter_by(user_name=username).first() # if this returns a user, then the user_name already exists in database
  # FIXME: check we render the error field in JS, not invalid_password=True..
  if login_type == "LDAP" and (not user or (user.login_type == 'LDAP')):
    return auth_ldap(username, password)
  # elif login_type == "SAML" and (not user or (user.login_type == 'SAML')):
  #   return auth_sso(username, password)
  else:
    return auth_local(username, password)


def auth_local(username, password):
  info = {
    "user_name": username,
    "login_type": "LOCAL",
    "login_success": False,
  }

  if is_login_restricted and not is_authorized_user(info):
    print(f"[auth] Unauthorized login @{username}")
    info["error"] = not_authorized_error
    session.clear()
    return info
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
    info["data"] = user.data
  return info

def ldap_connection():
  """Bound with the service account. QABOARD_LDAP_HOST can be ldaps://host, or set QABOARD_LDAP_START_TLS=true."""
  if ldap_host.startswith(('ldap://', 'ldaps://')):
    ldap_uri = ldap_host if not os.environ.get('QABOARD_LDAP_PORT') else f"{ldap_host}:{ldap_port}"
  else:
    ldap_uri = f"ldap://{ldap_host}" if not ldap_port else f"ldap://{ldap_host}:{ldap_port}"
  ldap_connect = ldap.initialize(ldap_uri)
  ldap_connect.set_option(ldap.OPT_REFERRALS, 0)
  if env_flag('QABOARD_LDAP_START_TLS'):
    ldap_connect.start_tls_s()
  ldap_connect.simple_bind_s(ldap_bind_dn, ldap_password)
  return ldap_connect


def ldap_search(user_name: str) -> str:
  return ldap_user_filter.replace("{login}", ldap.filter.escape_filter_chars(user_name))


def ldap_attributes() -> list:
  return [ldap_attr_common_name, ldap_attr_email, *ldap_group_attributes]


# Active Directory's LDAP_MATCHING_RULE_IN_CHAIN: the groups that contain the user, also through other groups
IN_CHAIN = '1.2.840.113556.1.4.1941'


def ldap_details(ldap_connect, user_name: str) -> list:
  """[[dn, {attribute: [values]}]], or [] if the directory doesn't know the user. Referrals come as entries without a DN."""
  details = [d for d in ldap_connect.search_s(ldap_user_base, ldap.SCOPE_SUBTREE, ldap_search(user_name), ldap_attributes()) if d[0]]
  if details and env_flag('QABOARD_LDAP_NESTED_GROUPS') and 'memberOf' in ldap_group_attributes:
    dn, attributes = details[0]
    base = os.environ.get('QABOARD_LDAP_GROUP_BASE') or ldap_user_base
    groups = ldap_connect.search_s(base, ldap.SCOPE_SUBTREE, f"(member:{IN_CHAIN}:={ldap.filter.escape_filter_chars(dn)})", ['cn'])
    direct = list(attributes.get('memberOf') or [])
    seen = {(v.decode() if isinstance(v, bytes) else v).casefold() for v in direct}
    attributes['memberOf'] = direct + [group_dn.encode() for group_dn, _ in groups if group_dn and group_dn.casefold() not in seen]
  return details


def ldap_user_info(details, user_info):
  """Fills user_info from the directory's answer"""
  user_ldap = details[0][1]
  user_info["full_name"] = str(user_ldap[ldap_attr_common_name][0], 'utf-8') if ldap_attr_common_name in user_ldap else None
  if ldap_attr_email not in user_ldap:
    user_info["email"] = None
  else:
    user_info["email"] = str(user_ldap[ldap_attr_email][0], 'utf-8')
  # serialize and deserialize to str-json, to avoid dealing with bytes-type errors. # FIXME: any better solution?
  user_info["data"] = simplejson.loads(simplejson.dumps(details))
  return user_info


def ldap_lookups(user_names):
  """(user_name, user_info or None if the directory doesn't know them), with one connection of the service account"""
  ldap_connect = ldap_connection()
  try:
    for user_name in user_names:
      details = ldap_details(ldap_connect, user_name)
      yield user_name, (ldap_user_info(details, {"user_name": user_name, "login_type": login_type}) if details else None)
  finally:
    ldap_connect.unbind_s()


def ldap_lookup(user_name: str):
  """
  What the directory knows about a user, with the service account: after an SSO sign-in, it keeps the accounts'
  attributes up to date (group rules and QABOARD_LOGIN_RESTRICTED_YAML's rules read them). None if unknown, or without LDAP.
  The daily group sync looks up every LDAP account (backend/jobs/groups.py).
  """
  if login_type != "LDAP":
    return None
  return next(ldap_lookups([user_name]))[1]


def auth_ldap(user_name, password):
  if login_type != "LDAP":
    raise Exception("LDAP authentication is disabled")
  user_info = {
    "user_name": user_name,
    "login_type": login_type,
    "login_success": False,
  }
  # A bind with an empty password is an anonymous bind, that many LDAP servers accept
  if not password:
    user_info["error"] = "invalid-password"
    return user_info
  ldap_connect = ldap_connection()
  # check if the user exists. Referrals come as entries without a DN.
  found = [entry for entry in ldap_connect.search_s(ldap_user_base, ldap.SCOPE_SUBTREE, ldap_search(user_name), ['distinguishedName']) if entry[0]]
  certificate = found[0][0] if found else None

  if certificate:
    # check the password and get the full user info
    try:
      ldap_connect.set_option(ldap.OPT_REFERRALS, 0)
      ldap_connect.simple_bind_s(certificate, password)
      details = ldap_details(ldap_connect, user_name)
      user_info["login_success"] = True
      ldap_user_info(details, user_info)
      if user_info["email"] is None:
        user_info["error"] = f"missing-email-({ldap_attr_email} LDAP attribute)"
    except (ldap.INVALID_CREDENTIALS, ldap.OPERATIONS_ERROR):
      user_info["error"] = "invalid-password"
  else:
    user_info["error"] = "invalid-username"
  ldap_connect.unbind_s()

  if user_info["login_success"]:
    if is_login_restricted and not is_authorized_user(user_info):
      user_info["login_success"] = False
      print(f"[auth] Unauthorized login @{user_name}")
      user_info["error"] = not_authorized_error
      session.clear()
      # return user_info
    else:
      user = User.query.filter_by(user_name=user_name).one_or_none()
      if user:
        user = update_user(user, user_info)
      else:
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
        if len(errors) == 0:
            if 'AuthNRequestID' in session:
                del session['AuthNRequestID']

            session['samlUserdata'] = auth.get_attributes()
            session['samlNameId'] = auth.get_nameid()
            session['samlNameIdFormat'] = auth.get_nameid_format()
            session['samlNameIdNameQualifier'] = auth.get_nameid_nq()
            session['samlNameIdSPNameQualifier'] = auth.get_nameid_spnq()
            session['samlSessionIndex'] = auth.get_session_index()

            if not session['samlUserdata']:
              errors.append(f"samlUserdata is empty.")
              return " ".join(errors), 403
            else: 
            # if len(session['samlUserdata']) > 0:
              samlUserdata = session['samlUserdata']
              user_info = {
              "login_type": login_type,
              # "is_ldap": False,
              # "is_sso": True,
              "user_name": samlUserdata.get(saml_attr_user_name, [])[0],
              "full_name": samlUserdata.get(saml_attr_common_name, [])[0],
              "email": samlUserdata.get(saml_attr_email, [])[0],
              "data": dict(samlUserdata),
              }
              if is_login_restricted and not is_authorized_user(user_info):
                print(f"[auth] Unauthorized login @{user_info['user_name']}")
                errors.append(not_authorized_error)
                session.clear()
                return " ".join(errors), 403

            user = User.query.filter_by(user_name=user_info.get("user_name")).one_or_none()
            if user:
              user = update_user(user, user_info)
            else:
              user = create_user(user_info)
            if user.status == 'disabled':
              session.clear()
              audit('auth.login_failed', 'user', user.id, user.user_name, meta={"reason": user.status, "login_type": "SAML"})
              db_session.commit()
              return redirect(f"/login?error=user_disabled")
            finish_sign_in(user, 'saml', subject=session.get('samlNameId') or user.user_name, claims={k: v for k, v in (session.get('samlUserdata') or {}).items()})
            return redirect(safe_redirect_url(request.form.get('RelayState')))
    elif 'sls' in request.args:
        request_id = None
        if 'LogoutRequestID' in session:
            request_id = session['LogoutRequestID']
        dscb = lambda: session.clear()
        url = auth.process_slo(request_id=request_id, delete_session_cb=dscb)
        errors = auth.get_errors()
        if len(errors) == 0:
            if url is not None:
                # our answer to the IdP's logout request: to its SLO URL, from our SAML settings
                return redirect(url)
            # the IdP's answer to our logout
            return redirect(safe_redirect_url(request.args.get('RelayState')))

    # Handle bad requests:
    # raise Exception(" ".join(errors))
    print(" ".join(errors))
    return " ".join(errors), 403


def safe_redirect_url(url) -> str:
  """Where to send users after they sign in: only our own pages, to avoid open redirects"""
  from urllib.parse import urlparse
  from ..actor import own_origins
  if not url or not isinstance(url, str):
    return '/'
  parsed = urlparse(url)
  if not parsed.scheme and not parsed.netloc and url.startswith('/') and not url.startswith('//') and '\\' not in url:
    return url
  if parsed.scheme in ('http', 'https') and (parsed.hostname or '').lower() in own_origins() and 'saml20' not in parsed.path:
    return url
  return '/'


def init_saml_auth(req):
    auth = OneLogin_Saml2_Auth(req, custom_base_path=app.config['SAML_PATH'])
    return auth

def prepare_flask_request(request):
    # If server is behind proxies or balancers use the HTTP_X_FORWARDED fields
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
