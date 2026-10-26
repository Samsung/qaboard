"""
Settings admins change from the web app, like Metabase: the environment wins, then the database, then the default.
The admin panel shows where each value comes from. Bootstrap settings (the database, SECRET_KEY, QABOARD_URL,
QABOARD_ADMINS...) only come from the environment and aren't listed here.

The database values are cached a few seconds per process, so every worker and replica sees changes quickly.
"""
import os
import time
import threading
from typing import Any, Callable, NamedTuple, Optional


def env_flag(value: str) -> bool:
  """"false", "0", "no", "off" or empty mean False, any other value (e.g. "true", "1") means True."""
  return value.strip().lower() not in ("", "0", "false", "no", "off")


def env_list(value: str) -> list:
  return [v.strip() for v in value.split(',') if v.strip()]


def sandbox_html() -> bool:
  """
  QABOARD_SANDBOX_HTML: the runs' HTML and SVG files can't act as whoever opens them. Off by default, for now: reports
  with scripts then run them in our origin. Read by the proxy too (services/nginx/configure.sh), set it for both.
  """
  return env_flag(os.environ.get('QABOARD_SANDBOX_HTML', ''))


def login_type() -> str:
  return (os.environ.get('QABOARD_LOGIN_TYPE') or 'LOCAL').upper()


class Definition(NamedTuple):
  description: str
  # a value, or a function returning it
  default: Any
  # bool, int, str, list
  type: type
  env: Optional[str] = None
  # turns the environment variable's text into the value
  parse_env: Optional[Callable[[str], Any]] = None
  choices: Optional[tuple] = None
  nullable: bool = False
  minimum: Optional[int] = None
  maximum: Optional[int] = None
  # never shown in full, e.g. webhook URLs: their path is the credential
  secret: bool = False


DEFINITIONS = {
  'auth.require_sign_in': Definition(
    "Anonymous users can't see anything: the API answers 401 except for signing in, and for ingest unless ingest.auth is \"token\".",
    False, bool, env='QABOARD_LOGIN_REQUIRED', parse_env=env_flag,
  ),
  'auth.local_signup': Definition(
    "Anyone can create a local account with a password. Off by default with LDAP or SAML: local accounts could take the names of directory users.",
    lambda: login_type() == 'LOCAL', bool, env='QABOARD_DISABLE_SIGNUP', parse_env=lambda v: not env_flag(v),
  ),
  'auth.allowed_origins': Definition(
    "Other origins (e.g. https://dashboards.example.com) allowed to make changes with the users' cookies. The server's own origin is always allowed.",
    [], list, env='QABOARD_ALLOWED_ORIGINS', parse_env=env_list,
  ),
  'ingest.auth': Definition(
    "How runs, batches and commits sent by `qa` are authenticated: \"off\" accepts anonymous results (they're marked unverified), \"warn\" also warns the senders, \"token\" requires a token with the ingest scope.",
    'off', str, env='QABOARD_INGEST_AUTH', choices=('off', 'warn', 'token'),
  ),
  'projects.default_visibility': Definition(
    "Who can see the projects whose owners didn't choose: \"public\" (anyone who can open QA-Board), \"internal\" (signed-in users), \"private\" (only their members).",
    'public', str, env='QABOARD_DEFAULT_VISIBILITY', choices=('public', 'internal', 'private'),
  ),
  'projects.signed_in_role': Definition(
    "The role of signed-in users on public and internal projects: \"developer\" (they can send results and act on runs, as before project roles) or \"viewer\". Members of a project, and private projects, follow their grants.",
    'developer', str, env='QABOARD_SIGNED_IN_ROLE', choices=('viewer', 'developer'),
  ),
  'tokens.default_lifetime_days': Definition(
    "The default lifetime of the tokens users create in the web app.",
    90, int, minimum=1,
  ),
  'tokens.max_lifetime_days': Definition(
    "The longest lifetime users may choose for their tokens. Empty: no maximum, and tokens without an expiry date are allowed.",
    None, int, nullable=True, minimum=1,
  ),
  'tokens.cli_idle_expiry_days': Definition(
    "Tokens created by `qa auth login` expire after this many days without being used.",
    180, int, minimum=1,
  ),
  'auth.access_policy': Definition(
    "Who gets an account when they first sign in: \"open\" (everyone a sign-in method accepts), \"domains\" (emails in auth.allowed_email_domains, the others wait for an admin), \"approval\" (everyone waits for an admin).",
    'open', str, env='QABOARD_ACCESS_POLICY', choices=('open', 'domains', 'approval'),
  ),
  'auth.allowed_email_domains': Definition(
    "With auth.access_policy \"domains\": the email domains whose users get an account right away, e.g. example.com.",
    [], list, env='QABOARD_ALLOWED_EMAIL_DOMAINS', parse_env=env_list,
  ),
  'auth.access_request_webhook': Definition(
    "An incoming webhook (Slack, Teams, Mattermost...) told when users wait for an admin. QA-Board sends {\"text\": \"...\"}.",
    None, str, env='QABOARD_ACCESS_REQUEST_WEBHOOK', nullable=True, secret=True,
  ),
  'auth.sso_auto_redirect': Definition(
    "When signing in is required and there is a single single sign-on method, the sign-in page goes straight to it. /login?local=1 still shows the password form.",
    False, bool, env='QABOARD_SSO_AUTO_REDIRECT', parse_env=env_flag,
  ),
  'sessions.idle_days': Definition(
    "Browser sessions end after this many days without activity.",
    30, int, minimum=1,
  ),
  'sessions.max_days': Definition(
    "Browser sessions end after this many days, active or not: users sign in again.",
    180, int, minimum=1, maximum=365,
  ),
  'audit.retention_days': Definition(
    "Audit events older than this are deleted by `qaboard-admin purge-audit` (run it from a scheduled job).",
    730, int, minimum=30,
  ),
  'jobs.failure_emails': Definition(
    "Email when a scheduled job (Admin > Storage > Schedules) fails or ends with errors. Requires QABOARD_SMTP_HOST.",
    True, bool, env='QABOARD_JOBS_FAILURE_EMAILS', parse_env=env_flag,
  ),
  'jobs.failure_email_to': Definition(
    "Who gets the emails about scheduled jobs that went wrong: user names or emails. Empty: the admins.",
    [], list, env='QABOARD_JOBS_FAILURE_EMAIL_TO', parse_env=env_list,
  ),
  'storage.others_visible_to': Definition(
    "Who sees other people's storage usage (Storage usage > Everyone's, Users): \"members\" (the project's developers and owners, from a grant, a group or qaboard.yaml: not every signed-in user) or \"signed_in\" (everyone who can see the project). Admins see everything.",
    'members', str, env='QABOARD_STORAGE_OTHERS_VISIBLE_TO', choices=('members', 'signed_in'),
  ),
  'storage.exports_root': Definition(
    "Where \"Export to a shared folder\" puts exports: <this folder>/<user>/<project>/<date>-<id>, all in one place where users find and delete them (Storage usage > Exports). Empty: in a share/ folder next to the commit's runs, as before. It must be in the storage (QABOARD_STORAGE_ROOTS).",
    None, str, env='QABOARD_EXPORTS_ROOT', nullable=True,
  ),
}


CACHE_SECONDS = 5
_cache = {"values": None, "loaded_at": 0.0}
_lock = threading.Lock()


def _database_values() -> dict:
  now = time.monotonic()
  if _cache["values"] is not None and now - _cache["loaded_at"] < CACHE_SECONDS:
    return _cache["values"]
  from .models import Setting
  try:
    values = {s.key: (s.value or {}).get('value') for s in Setting.query.all()}
  except Exception as e:
    # e.g. before the migrations ran: the defaults are safe
    print(f"[settings] WARNING: could not read the settings: {type(e).__name__}")
    from backend import db_session
    db_session.rollback()
    values = {}
  with _lock:
    _cache.update(values=values, loaded_at=now)
  return values


def invalidate_cache():
  with _lock:
    _cache.update(values=None, loaded_at=0.0)


def default(key: str):
  value = DEFINITIONS[key].default
  return value() if callable(value) else value


def from_env(key: str):
  """(is set, value) from the environment"""
  definition = DEFINITIONS[key]
  # empty means unset: docker-compose.yml passes some variables as `VAR=${VAR:-}`
  if not definition.env or not os.environ.get(definition.env, '').strip():
    return False, None
  raw = os.environ[definition.env]
  if definition.parse_env:
    return True, definition.parse_env(raw)
  try:
    return True, validate(key, _normalize(definition, raw if definition.type is str else _parse_text(definition, raw)))
  except ValueError as e:
    # the admin panel's checklist shows it (invalid_env)
    print(f"[settings] WARNING: ignoring ${definition.env}: {e}")
    return False, None


def _parse_text(definition: Definition, raw: str):
  if definition.type is bool:
    return env_flag(raw)
  if definition.type is int:
    if not raw.strip() and definition.nullable:
      return None
    try:
      return int(raw)
    except ValueError:
      raise ValueError(f"expected a number, got {raw!r}")
  if definition.type is list:
    return env_list(raw)
  return raw


def source(key: str) -> str:
  if from_env(key)[0]:
    return 'env'
  if key in _database_values():
    return 'database'
  return 'default'


def setting(key: str):
  """The value of a setting: from the environment, else the database, else the default."""
  is_set, value = from_env(key)
  if is_set:
    return value
  values = _database_values()
  if key in values:
    return values[key]
  return default(key)


def validate(key: str, value):
  """The value, checked against the setting's definition. Raises ValueError with a sentence for people."""
  if key not in DEFINITIONS:
    raise ValueError(f"Unknown setting: {key}")
  definition = DEFINITIONS[key]
  if value is None:
    if definition.nullable:
      return None
    raise ValueError(f"{key} can't be empty")
  if definition.type is bool:
    if not isinstance(value, bool):
      raise ValueError(f"{key} must be true or false")
  elif definition.type is int:
    if isinstance(value, bool) or not isinstance(value, int):
      raise ValueError(f"{key} must be a whole number")
    if definition.minimum is not None and value < definition.minimum:
      raise ValueError(f"{key} must be at least {definition.minimum}")
    if definition.maximum is not None and value > definition.maximum:
      raise ValueError(f"{key} must be at most {definition.maximum}")
  elif definition.type is list:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
      raise ValueError(f"{key} must be a list of texts")
  elif definition.type is str:
    if not isinstance(value, str):
      raise ValueError(f"{key} must be a text")
  if definition.choices and value not in definition.choices:
    raise ValueError(f"{key} must be one of: {', '.join(definition.choices)}")
  if key == 'storage.exports_root':
    from .storage import check_storage_path, UnsafePathError
    if not value.startswith('/'):
      raise ValueError(f"{key} must be an absolute path, e.g. /algo/qaboard/exports")
    try:
      check_storage_path(value)
    except UnsafePathError as e:
      raise ValueError(str(e))
  return value


def save(key: str, value, by=None):
  """Stores a valid value (None resets the default), in the current database session: the caller commits. Returns the new value."""
  from backend import db_session
  from .models import Setting
  from .tokens import utcnow
  row = Setting.query.filter(Setting.key == key).one_or_none()
  if value is None:
    if row is not None:
      db_session.delete(row)
    return default(key)
  if row is None:
    row = Setting(key=key)
    db_session.add(row)
  row.value = {"value": value}
  row.updated_by_id = by.id if by is not None else None
  row.updated_at = utcnow()
  return value


def invalid_env() -> dict:
  """{key: problem} for the settings whose environment variable is set but invalid (they're ignored)"""
  problems = {}
  for key, definition in DEFINITIONS.items():
    raw = os.environ.get(definition.env, '').strip() if definition.env else ''
    if not raw or definition.parse_env:
      continue
    try:
      validate(key, _normalize(definition, raw if definition.type is str else _parse_text(definition, raw)))
    except ValueError as e:
      problems[key] = f"${definition.env}={raw!r}: {e}"
  return problems


def _normalize(definition: Definition, value):
  # QABOARD_INGEST_AUTH=Token means "token"
  if definition.choices and isinstance(value, str):
    return value.strip().lower()
  return value


def masked(key: str, value):
  """What admins see of a secret setting: https://hooks.slack.com/…"""
  if not DEFINITIONS[key].secret or value in (None, ''):
    return value
  from urllib.parse import urlparse
  url = urlparse(str(value))
  return f"{url.scheme}://{url.netloc}/…" if url.scheme and url.netloc else "…"


def describe(key: str) -> dict:
  definition = DEFINITIONS[key]
  current_source = source(key)
  return {
    "key": key,
    "value": masked(key, setting(key)),
    "default": masked(key, default(key)),
    "secret": definition.secret,
    "source": current_source,
    "env": definition.env,
    "description": definition.description,
    "type": definition.type.__name__,
    "choices": list(definition.choices) if definition.choices else None,
    "nullable": definition.nullable,
    # the environment wins: changing the database value would have no effect
    "editable": current_source != 'env',
    "error": invalid_env().get(key),
  }


def describe_all() -> list:
  return [describe(key) for key in DEFINITIONS]
