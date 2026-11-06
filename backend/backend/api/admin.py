"""
The admin panel's API: users, tokens, the audit log, settings, a security checklist, and what to configure or look at
to get more from QA-Board.
Admins are users with `is_admin` and those in $QABOARD_ADMINS (see backend/admins.py).
"""
import os
import datetime

from flask import request, jsonify, g
from sqlalchemy import or_, func

from backend import app, db_session
from ..models import User, Token, AuditEvent
from ..admins import is_admin, is_env_admin, env_admins
from ..audit import audit, diff, serialize as serialize_event
from .. import settings as settings_lib
from .. import tokens as tokens_lib
from .. import usage as usage_lib
from ..hybrid_cache import hybrid_cache
from .auth import admin_required, is_login_restricted
from .users import page_of_events
from ..search import escape_like
from ..sign_in.profiles import avatar_url, public as public_profile


USER_STATUSES = ('active', 'pending', 'disabled')


def active_tokens_query():
  now = tokens_lib.utcnow()
  return (Token.query
          .filter(Token.revoked.isnot(True), Token.revoked_at.is_(None))
          .filter(or_(Token.expires_at.is_(None), Token.expires_at > now)))


def serialize_user(user, active_tokens=None) -> dict:
  return {
    "id": user.id,
    "user_name": user.user_name,
    "full_name": user.full_name,
    "email": user.email,
    "kind": user.kind,
    "status": user.status,
    "is_admin": is_admin(user),
    "is_admin_from_env": is_env_admin(user),
    "login_type": user.login_type,
    "created_date": tokens_lib.iso(user.created_date),
    "last_login_at": tokens_lib.iso(user.last_login_at),
    "active_tokens": active_tokens,
    "avatar_url": avatar_url(user),
  }


def pagination(default_limit=50):
  try:
    limit = max(1, min(int(request.args.get('limit', default_limit)), 500))
    offset = max(0, int(request.args.get('offset', 0)))
  except ValueError:
    return None, None
  return limit, offset


def active_token_counts(user_ids) -> dict:
  if not user_ids:
    return {}
  rows = (active_tokens_query()
          .with_entities(Token.user_id, Token.expires_at, Token.idle_expiry_days, Token.last_used_at, Token.created_at)
          .filter(Token.user_id.in_(user_ids)).all())
  now = tokens_lib.utcnow()
  counts = {}
  for user_id, _, idle_days, last_used_at, created_at in rows:
    last = last_used_at or created_at
    if idle_days and last and now >= last + datetime.timedelta(days=idle_days):
      continue
    counts[user_id] = counts.get(user_id, 0) + 1
  return counts


@app.route('/api/v1/admin/overview', methods=['GET'])
@app.route('/api/v1/admin/overview/', methods=['GET'])
@admin_required
def admin_overview():
  now = tokens_lib.utcnow()
  month_ago = now - datetime.timedelta(days=30)
  # who used QA-Board: a usage event, or a sign-in (sessions last for days, so sign-ins alone undercount)
  active = {u for (u,) in db_session.query(User.id).filter(User.last_login_at > month_ago, User.kind == 'human').all()}
  active |= usage_lib.active_user_ids(month_ago)
  counts = {
    "users": User.query.filter(User.kind == 'human').count(),
    "active_30d": len(active),
    "admins": sum(1 for u in User.query.filter(User.status == 'active').all() if is_admin(u)),
    "pending": User.query.filter(User.status == 'pending').count(),
    "disabled": User.query.filter(User.status == 'disabled').count(),
    "active_tokens": sum(active_token_counts([u for (u,) in db_session.query(User.id).all()]).values()),
  }
  return jsonify({"counts": counts, "checklist": checklist(), "value_checklist": value_checklist()})


def checklist() -> list:
  """What admins should look at to secure their server"""
  items = []
  def item(id, ok, severity, title, detail, ok_detail=None):
    # what to do when it's not ok, else what to know, if anything
    items.append({"id": id, "ok": ok, "severity": 'info' if ok else severity, "title": title, "detail": ok_detail if ok else detail})

  require_sign_in = settings_lib.setting('auth.require_sign_in')
  item('require_sign_in', require_sign_in, 'warning',
       "Sign-in is required" if require_sign_in else "Anonymous users can read every project",
       "Set auth.require_sign_in to require signing in, except for sending results (see ingest.auth).",
       "Anonymous users only see the sign-in page. Results sent by qa follow ingest.auth.")

  ingest = settings_lib.setting('ingest.auth')
  item('ingest_auth', ingest == 'token', 'warning' if ingest == 'off' else 'info',
       {"off": "Anyone who can reach the server can send results", "warn": "Results without a token are accepted, with a warning",
        "token": "Sending results requires a token"}[ingest],
       {"off": "Results sent without a token are marked unverified. Move ingest.auth to \"warn\", then \"token\", once CI jobs use tokens (QABOARD_TOKEN).",
        "warn": "qa asks users to sign in. Move ingest.auth to \"token\" once all CI jobs use tokens (QABOARD_TOKEN).",
        "token": None}[ingest],
       "CI jobs need a token with the ingest scope, in QABOARD_TOKEN.")

  anonymous_jobs = settings_lib.setting('jenkins.anonymous_jobs')
  item('jenkins_anonymous_jobs', not anonymous_jobs, 'warning',
       "Jenkins jobs start only with a token, or from a project's qaboard.yaml" if not anonymous_jobs else f"Anyone can start the Jenkins jobs matching {', '.join(anonymous_jobs)}",
       "jenkins.anonymous_jobs lets callers without a token start these jobs with the server's Jenkins credentials. Empty it once their scripts send tokens.")

  from backend import app
  secure = bool(app.config.get('SESSION_COOKIE_SECURE'))
  item('https', secure, 'warning', "Cookies are only sent over HTTPS" if secure else "Cookies can be sent over plain HTTP",
       "Serve QA-Board over HTTPS and set QABOARD_URL=https://…: session cookies then get the Secure flag.")

  item('secret_key', bool(os.environ.get('SECRET_KEY')), 'info',
       "SECRET_KEY is set" if os.environ.get('SECRET_KEY') else "SECRET_KEY was generated by the server",
       "The generated key is saved in the data folder: all the replicas must share it. Setting $SECRET_KEY is simpler with several hosts.")

  legacy = active_tokens_query().filter(Token.kind == 'legacy').count()
  item('legacy_tokens', legacy == 0, 'warning',
       "No legacy tokens" if not legacy else f"{legacy} legacy token{'s' if legacy > 1 else ''} without an expiry date",
       "Tokens created before scopes can read, send results and act as their user, forever. Ask their owners to replace them (Admin → Tokens).")

  local_signup = settings_lib.setting('auth.local_signup')
  login_type = settings_lib.login_type()
  risky_signup = local_signup and (login_type != 'LOCAL' or require_sign_in)
  item('local_signup', not risky_signup, 'danger' if login_type != 'LOCAL' else 'warning',
       "Local sign-up is off" if not local_signup else ("Anyone can create a local account" if login_type != 'LOCAL' else "Anyone can create an account"),
       "With LDAP or SAML, local accounts could take the names of directory users who never signed in. Turn auth.local_signup off."
       if login_type != 'LOCAL' else "Sign-in is required, but anyone can create an account: turn auth.local_signup off, and create accounts in Admin → Users (New user), or with qaboard-admin create-admin --password.",
       "Turn auth.local_signup off if only admins should create accounts (Admin → Users → New user)." if local_signup else None)

  from ..git_hosts import git_hosts
  webhooks_signed = git_hosts.has_webhook_secrets()
  item('webhook_secret', webhooks_signed, 'warning',
       "Git hosts' webhooks must send a secret" if webhooks_signed else "Anyone can send push webhooks",
       "Without a webhook secret, anyone who can reach the server can send fake push events: they change the projects' git data and make the server fetch repositories. Set one in Admin → Settings → Git hosts, and the same secret in the git hosts' webhooks.")

  for key, problem in settings_lib.invalid_env().items():
    definition = settings_lib.DEFINITIONS[key]
    used = settings_lib.masked(key, settings_lib.setting(key))
    item(f'invalid_env:{key}', False, 'danger', f"${definition.env} is invalid: it's ignored",
         f"{problem}. QA-Board uses {key} = {used!r} instead: fix the server's environment.")

  for key, problem in settings_lib.undecryptable().items():
    item(f'undecryptable:{key}', False, 'danger', f"{settings_lib.DEFINITIONS[key].label or key} can't be decrypted",
         f"{problem} Until then, QA-Board uses the default (Admin → Settings).")

  items.extend(encryption_items())

  from ..models import RoleGrant
  signed_in_role = settings_lib.setting('projects.signed_in_role')
  owned = RoleGrant.query.filter(RoleGrant.resource_type == 'project', RoleGrant.role == 'owner').count()
  item('signed_in_role', signed_in_role == 'viewer', 'info',
       "Signed-in users are viewers of public and internal projects" if signed_in_role == 'viewer' else "Everyone signed in can send results and act on every project",
       f"projects.signed_in_role is developer, as before project roles. {owned} project owner grant{'s' if owned != 1 else ''} so far: once projects have owners, set it to viewer, and owners make their teams developers (Project → Access).",
       "Owners make their teams developers in Project → Access. Private projects only follow their members.")

  if is_login_restricted:
    item('restrictions_yaml', True, 'info', "Project restrictions also come from QABOARD_LOGIN_RESTRICTED_YAML",
         "Its projects are private, and the users its rules match are their developers. Owners can add members in Project → Access.")
  return items


def encryption_items() -> list:
  """The security checklist's items about the key that encrypts the secrets stored in the database"""
  from .admin_settings import encryption_status
  status = encryption_status()
  secrets = status.get("secrets") or {}
  key = status.get("key")
  items = []
  def item(id, severity, title, detail):
    items.append({"id": id, "ok": False, "severity": severity, "title": title, "detail": detail})
  unreadable = secrets.get("unreadable") or []
  if unreadable:
    item('encryption_unreadable', 'danger', f"{len(unreadable)} stored secret{'s' if len(unreadable) > 1 else ''} can't be decrypted",
         "They were encrypted with another key than this server's: restore that key ($QABOARD_ENCRYPTION_KEY, or $QABOARD_ENCRYPTION_KEY_PREVIOUS while you rotate), or enter them again (Admin → Settings → Security).")
  for problem in status.get("problems") or []:
    item('encryption_problem', 'danger', "The encryption key can't be read", problem)
  if key and key["source"] == 'generated' and secrets.get("total"):
    item('encryption_generated', 'warning', "Back up the encryption key the server generated",
         f"The secrets stored in the database can only be decrypted with the key in {key['origin']}, and database backups don't include it. Copy it to your secret store as QABOARD_ENCRYPTION_KEY: `qaboard-admin encryption show-key`.")
  if status.get("weak"):
    item('encryption_weak', 'warning', "The encryption key is short",
         "Use at least 32 random characters, e.g. `openssl rand -base64 32`, then `qaboard-admin encryption rotate` with the old key in $QABOARD_ENCRYPTION_KEY_PREVIOUS.")
  if secrets.get("to_rotate") and not unreadable:
    item('encryption_rotate', 'info', f"{secrets['to_rotate']} stored secret{'s' if secrets['to_rotate'] > 1 else ''} use{'' if secrets['to_rotate'] > 1 else 's'} an older key",
         "Re-encrypt them with the current key (Admin → Settings → Security, or `qaboard-admin encryption rotate`), then remove the old key.")
  return items


USAGE_LOOKBACK_DAYS = 90
# The usage-based items read the last months of events: computed at most every hour (they're about 90 days), for all
# the server's processes (Redis). The overview doesn't wait for them: the web app asks /api/v1/admin/overview/usage.
USAGE_ITEMS_CACHE_SECONDS = 3600


@hybrid_cache(ttl=USAGE_ITEMS_CACHE_SECONDS, maxsize=1)
def usage_items() -> dict:
  """{ci_only, web_only, products} of the last USAGE_LOOKBACK_DAYS days, cached for USAGE_ITEMS_CACHE_SECONDS"""
  since = tokens_lib.utcnow() - datetime.timedelta(days=USAGE_LOOKBACK_DAYS)
  return {
    "ci_only": usage_lib.ci_only_projects(since),
    "web_only": usage_lib.web_only_users(since),
    "products": usage_lib.tuning_products(since),
  }


def value_checklist() -> list:
  """What admins can configure, or look at, to get more from QA-Board: it's not about security"""
  items = []
  def item(id, ok, title, detail, ok_detail=None):
    items.append({"id": id, "ok": ok, "severity": 'info', "title": title, "detail": ok_detail if ok else detail})

  from ..notifications.mail import email_enabled
  emails = email_enabled()
  item('email_notifications', emails,
       "Email notifications are on" if emails else "Email notifications aren't configured",
       "Set the SMTP server in Admin → Settings → Email: users can then ask for an email when the batches they start end, and admins hear about failed jobs.")

  from ..sign_in import providers as providers_lib
  login_type = settings_lib.login_type()
  # the local provider is always there: the company's accounts are LDAP, SAML, or an OpenID Connect provider
  sso = login_type in ('LDAP', 'SAML') or any(p.enabled and p.type not in ('local', 'ldap') for p in providers_lib.all_providers())
  item('single_sign_on', sso,
       "Users sign in with the company's accounts" if sso else "Users sign in with local accounts",
       "Add a single sign-on provider (Admin > Sign-in): no passwords to manage, and groups come from the directory.")

  # gitlab.com and github.com are always known: a host is configured when the settings name one, or give a token
  from ..git_hosts import hosts_configured
  hosts = hosts_configured()
  item('git_hosts', hosts,
       "Git hosts are configured" if hosts else "No git host is configured",
       "Add your git hosts in Admin → Settings → Git hosts, and their webhooks: commits, branches and messages then show up as they're pushed, before runs arrive.")

  sentry = bool(os.environ.get('SENTRY_DSN'))
  item('sentry', sentry, "Errors are reported to Sentry" if sentry else "Errors aren't reported anywhere",
       "Set SENTRY_DSN: errors in users' browsers, in `qa` and in the server are then reported, with what led to them.")

  from ..annotations import describe_sources
  annotations = bool(describe_sources())
  item('annotation_sources', annotations,
       "The image viewer has annotation sources" if annotations else "No annotation sources",
       "Configure QABOARD_ANNOTATION_SOURCES: the image viewer then shows the labels, boxes and regions of other tools over the runs' images.")

  from ..models import JobSchedule
  gc = JobSchedule.query.filter(JobSchedule.kind == 'garbage_collect', JobSchedule.enabled.is_(True)).count() > 0
  item('garbage_collect', gc,
       "Old results are deleted on a schedule" if gc else "Nothing deletes old results",
       "Add a schedule for \"Delete old results\" (Admin > Storage > Schedules): the storage then stays in check without anyone remembering to clean it.")

  from ..models import RoleGrant, Project
  owners = RoleGrant.query.filter(RoleGrant.resource_type == 'project', RoleGrant.role == 'owner').count()
  projects = Project.query.count()
  item('project_owners', owners > 0 or projects == 0,
       "Projects have owners" if owners > 0 else ("No projects yet" if projects == 0 else "No project has an owner"),
       "Make the people in charge of each project its owners (Project > Access): they can then add their team, restrict who sees it, and get the access requests.")

  return items


def usage_checklist() -> list:
  """The "Get more from QA-Board" items about how QA-Board is used, from the last USAGE_LOOKBACK_DAYS days of events"""
  items = []
  def item(id, ok, title, detail, ok_detail=None):
    items.append({"id": id, "ok": ok, "severity": 'info', "title": title, "detail": ok_detail if ok else detail})

  cached = usage_items()
  ci_only = cached['ci_only']
  item('ci_only_projects', not ci_only,
       f"Every project with CI runs was looked at in the last {USAGE_LOOKBACK_DAYS} days" if not ci_only
       else f"{len(ci_only)} project{'s' if len(ci_only) > 1 else ''} get CI runs nobody looked at in {USAGE_LOOKBACK_DAYS} days",
       f"Show their teams around, or stop their CI jobs: {', '.join(ci_only[:5])}{'…' if len(ci_only) > 5 else ''} (Admin > Usage > Projects).")

  web_only = cached['web_only']
  item('web_only_users', not web_only,
       f"Everyone active in the web app used the CLI in the last {USAGE_LOOKBACK_DAYS} days" if not web_only
       else f"{len(web_only)} user{'s' if len(web_only) > 1 else ''} active in the web app didn't use the CLI in {USAGE_LOOKBACK_DAYS} days",
       "They only read results: `qa batch` from their terminal and `qa auth login` let them run and tune their own experiments (Admin > Usage > Users).")

  products = cached['products']
  without_tuning = sorted(product for product, tuning in products.items() if not tuning)
  item('tuning_products', not without_tuning,
       f"Every product in use started a tuning in the last {USAGE_LOOKBACK_DAYS} days" if not without_tuning
       else f"{len(without_tuning)} product{'s' if len(without_tuning) > 1 else ''} in use didn't start a tuning in {USAGE_LOOKBACK_DAYS} days",
       f"Tuning from the web app may not be known there: {', '.join(without_tuning[:5])}{'…' if len(without_tuning) > 5 else ''}.")
  return items


@app.route('/api/v1/admin/overview/usage', methods=['GET'])
@app.route('/api/v1/admin/overview/usage/', methods=['GET'])
@admin_required
def admin_overview_usage():
  """The overview's usage-based items: apart, they can take seconds when they're not cached"""
  return jsonify({"items": usage_checklist(), "lookback_days": USAGE_LOOKBACK_DAYS})


@app.route('/api/v1/admin/users', methods=['GET'])
@app.route('/api/v1/admin/users/', methods=['GET'])
@admin_required
def admin_users():
  limit, offset = pagination()
  if limit is None:
    return jsonify({"error": "limit and offset must be numbers"}), 400
  query = User.query
  search = (request.args.get('search') or '').strip()
  if search:
    pattern = f"%{search}%"
    query = query.filter(or_(User.user_name.ilike(pattern), User.full_name.ilike(pattern), User.email.ilike(pattern)))
  status = request.args.get('status')
  if status:
    if status not in USER_STATUSES:
      return jsonify({"error": f"status must be one of {', '.join(USER_STATUSES)}"}), 400
    query = query.filter(User.status == status)
  if request.args.get('admin') in ('true', '1'):
    # few admins: we check $QABOARD_ADMINS's rules in Python
    candidates = env_admins()
    emails = [a.lower() for a in candidates if '@' in a]
    query = query.filter(or_(User.is_admin.is_(True), User.user_name.in_(candidates), func.lower(User.email).in_(emails)))
    users = [u for u in query.order_by(User.last_login_at.desc().nullslast(), User.id.desc()).all() if is_admin(u) or u.is_admin]
    total = len(users)
    users = users[offset:offset + limit]
  else:
    total = query.count()
    users = query.order_by(User.last_login_at.desc().nullslast(), User.id.desc()).offset(offset).limit(limit).all()
  counts = active_token_counts([u.id for u in users])
  return jsonify({"users": [serialize_user(u, counts.get(u.id, 0)) for u in users], "total": total})


def get_user_or_404(user_id):
  user = User.query.filter(User.id == user_id).one_or_none()
  if user is None:
    return None, (jsonify({"error": "This user doesn't exist."}), 404)
  return user, None


@app.route('/api/v1/admin/users', methods=['POST'])
@app.route('/api/v1/admin/users/', methods=['POST'])
@admin_required
def admin_create_user():
  """
  {user_name, full_name?, email?, password?, is_admin?}: a local account, active right away.
  Without a password, we generate one: the answer has it, once, for the admin to give to its owner.
  """
  from .. import first_admin
  body = request.get_json(silent=True) or {}
  user_name = body.get('user_name')
  user_name = user_name.strip() if isinstance(user_name, str) else user_name
  email = (body.get('email') or '').strip() or None
  full_name = (body.get('full_name') or '').strip() or None
  make_admin = body.get('is_admin', False)
  if not isinstance(make_admin, bool):
    return jsonify({"error": "is_admin must be true or false", "field": "is_admin"}), 400
  generated = not body.get('password')
  password = first_admin.generate_password() if generated else body.get('password')
  for field, problem in [('user_name', first_admin.user_name_problem(user_name)), ('email', first_admin.email_problem(email)),
                         ('password', None if generated else first_admin.password_problem(password))]:
    if problem:
      return jsonify({"error": problem, "field": field}), 400
  user = first_admin.new_local_user(user_name, password, full_name=full_name, email=email, is_admin=make_admin)
  audit('user.create', 'user', user.id, user.user_name, meta={"login_type": "LOCAL", "is_admin": make_admin, "generated_password": generated})
  db_session.commit()
  return jsonify({"user": serialize_user(user, 0), **({"password": password} if generated else {})}), 201


@app.route('/api/v1/admin/users/<int:user_id>/password', methods=['POST'])
@app.route('/api/v1/admin/users/<int:user_id>/password/', methods=['POST'])
@admin_required
def admin_reset_password(user_id):
  """
  {password?}: a new password for a local account, generated without one (the answer has it, once).
  Its owner is signed out of every browser. Their tokens keep working: revoke them apart.
  """
  from .. import first_admin
  from ..sign_in.sessions import revoke_all
  user, error = get_user_or_404(user_id)
  if error:
    return error
  if user.kind != 'human' or (user.login_type or '').upper() != 'LOCAL':
    return jsonify({"error": f"{user.user_name} doesn't have a local account: they sign in with {user.login_type or 'single sign-on'}, whose password QA-Board doesn't know."}), 400
  if user.id == g.actor.user.id:
    return jsonify({"error": "Change your own password in Settings → Sign-in methods."}), 400
  body = request.get_json(silent=True) or {}
  generated = not body.get('password')
  password = first_admin.generate_password() if generated else body.get('password')
  if not generated and (problem := first_admin.password_problem(password)):
    return jsonify({"error": problem, "field": "password"}), 400
  from .auth import generate_password_hash
  user.password = generate_password_hash(password)
  signed_out = revoke_all(user.id)
  audit('user.password_reset', 'user', user.id, user.user_name, meta={"generated_password": generated, "sessions_revoked": signed_out})
  db_session.commit()
  return jsonify({"signed_out": signed_out, **({"password": password} if generated else {})})


@app.route('/api/v1/admin/users/<int:user_id>', methods=['GET'])
@app.route('/api/v1/admin/users/<int:user_id>/', methods=['GET'])
@admin_required
def admin_user(user_id):
  user, error = get_user_or_404(user_id)
  if error:
    return error
  tokens = Token.query.filter(Token.user_id == user.id).order_by(Token.id.desc()).all()
  events = (AuditEvent.query
            .filter(or_(AuditEvent.actor_user_id == user.id, (AuditEvent.target_type == 'user') & (AuditEvent.target_id == str(user.id))))
            .order_by(AuditEvent.id.desc()).limit(50).all())
  counts = active_token_counts([user.id])
  from ..models import AccessRequest
  from ..sign_in.access import serialize as serialize_request
  access_request = AccessRequest.query.filter(AccessRequest.user_id == user.id).order_by(AccessRequest.id.desc()).first()
  return jsonify({
    "user": {**serialize_user(user, counts.get(user.id, 0)), "profile": public_profile(user)},
    "tokens": [tokens_lib.serialize(t) for t in tokens],
    "audit": [serialize_event(e) for e in events],
    # the latest, pending or decided
    "access_request": serialize_request(access_request) if access_request else None,
  })


@app.route('/api/v1/admin/users/<int:user_id>', methods=['POST'])
@app.route('/api/v1/admin/users/<int:user_id>/', methods=['POST'])
@admin_required
def admin_update_user(user_id):
  user, error = get_user_or_404(user_id)
  if error:
    return error
  body = request.get_json(silent=True) or {}
  me = g.actor.user
  before = {"status": user.status, "is_admin": bool(user.is_admin)}
  if 'status' in body:
    status = body['status']
    if status not in USER_STATUSES:
      return jsonify({"error": f"status must be one of {', '.join(USER_STATUSES)}"}), 400
    if user.id == me.id and status != 'active':
      return jsonify({"error": "You can't disable your own account: ask another admin."}), 400
    if status != 'active' and is_env_admin(user):
      return jsonify({"error": f"{user.user_name} is an admin because of $QABOARD_ADMINS: remove them from it first."}), 400
    user.status = status
  if 'is_admin' in body:
    if not isinstance(body['is_admin'], bool):
      return jsonify({"error": "is_admin must be true or false"}), 400
    if not body['is_admin'] and is_env_admin(user):
      return jsonify({"error": f"{user.user_name} is an admin because of $QABOARD_ADMINS: remove them from it first."}), 400
    if user.id == me.id and not body['is_admin']:
      return jsonify({"error": "You can't remove your own admin role: ask another admin."}), 400
    user.is_admin = body['is_admin']
  changes = diff(before, {"status": user.status, "is_admin": bool(user.is_admin)})
  if changes:
    audit('user.update', 'user', user.id, user.user_name, changes=changes)
  if 'status' in changes:
    from ..sign_in.access import decide
    from ..sign_in.sessions import revoke_all
    if before['status'] == 'pending':
      decide(user, user.status, by=me)
    if user.status == 'disabled':
      revoke_all(user.id)
  db_session.commit()
  counts = active_token_counts([user.id])
  return jsonify(serialize_user(user, counts.get(user.id, 0)))


@app.route('/api/v1/admin/users/<int:user_id>/revoke-tokens', methods=['POST'])
@app.route('/api/v1/admin/users/<int:user_id>/revoke-tokens/', methods=['POST'])
@admin_required
def admin_revoke_user_tokens(user_id):
  user, error = get_user_or_404(user_id)
  if error:
    return error
  revoked = 0
  for token in Token.query.filter(Token.user_id == user.id).all():
    if tokens_lib.revoke(token, by=g.actor.user, reason='admin'):
      revoked += 1
  db_session.commit()
  return jsonify({"revoked": revoked})


@app.route('/api/v1/admin/tokens', methods=['GET'])
@app.route('/api/v1/admin/tokens/', methods=['GET'])
@admin_required
def admin_tokens():
  limit, offset = pagination()
  if limit is None:
    return jsonify({"error": "limit and offset must be numbers"}), 400
  query = Token.query
  if request.args.get('user'):
    try:
      query = query.filter(Token.user_id == int(request.args['user']))
    except ValueError:
      return jsonify({"error": "user must be a user id"}), 400
  status = request.args.get('status')
  statuses = ('active', 'expired', 'idle_expired', 'revoked')
  if status and status not in statuses:
    return jsonify({"error": f"status must be one of {', '.join(statuses)}"}), 400
  tokens = query.order_by(Token.id.desc()).all()
  # few enough to filter here: the status depends on dates and on the idle expiry
  if status:
    tokens = [t for t in tokens if tokens_lib.status(t) == status]
  page = tokens[offset:offset + limit]
  return jsonify({"tokens": [tokens_lib.serialize(t, with_user=True) for t in page], "total": len(tokens)})


@app.route('/api/v1/admin/tokens/<int:token_id>', methods=['DELETE'])
@app.route('/api/v1/admin/tokens/<int:token_id>/', methods=['DELETE'])
@admin_required
def admin_revoke_token(token_id):
  token = Token.query.filter(Token.id == token_id).one_or_none()
  if token is None:
    return jsonify({"error": "This token doesn't exist."}), 404
  tokens_lib.revoke(token, by=g.actor.user, reason='admin')
  db_session.commit()
  return jsonify(tokens_lib.serialize(token, with_user=True))


@app.route('/api/v1/admin/audit', methods=['GET'])
@app.route('/api/v1/admin/audit/', methods=['GET'])
@admin_required
def admin_audit():
  query = AuditEvent.query
  if request.args.get('action'):
    action = request.args['action']
    # "token" matches every token.* action
    query = query.filter(or_(AuditEvent.action == action, AuditEvent.action.like(f"{escape_like(action)}.%", escape='\\')))
  if request.args.get('actor'):
    query = query.filter(AuditEvent.actor_label == request.args['actor'])
  if request.args.get('target_type'):
    query = query.filter(AuditEvent.target_type == request.args['target_type'])
  if request.args.get('target_id'):
    query = query.filter(AuditEvent.target_id == request.args['target_id'])
  if request.args.get('project'):
    query = query.filter(AuditEvent.project_id == request.args['project'])
  answer, error = page_of_events(query, default_limit=100)
  return error or jsonify(answer)


@app.route('/api/v1/admin/audit/actions', methods=['GET'])
@app.route('/api/v1/admin/audit/actions/', methods=['GET'])
@admin_required
def admin_audit_actions():
  actions = [a for (a,) in db_session.query(AuditEvent.action).distinct().order_by(AuditEvent.action).all()]
  return jsonify({"actions": actions})


# Settings: see api/admin_settings.py
