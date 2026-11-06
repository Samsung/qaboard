"""
The first admin of a new server, and local passwords.

A new server, without accounts yet, offers the setup page (/setup in the web app): it creates the first admin, a local
account, for whoever has the setup token. The server prints the token in its logs, and `qaboard-admin setup-token`
shows it: only the people who run the server know it, not whoever reaches the new server first. Until the setup is
done, local sign-up is refused: the first account is the admin's.

The environment can do it instead, for automated installs:
- QABOARD_ADMIN_PASSWORD (or QABOARD_ADMIN_PASSWORD_FILE, e.g. a Docker or Kubernetes secret) creates the local admin
  QABOARD_ADMIN_USER (default: admin) when the server starts without admins. Later changes don't change the password.
- QABOARD_SETUP_TOKEN chooses the setup token, else it's derived from the server's SECRET_KEY: every replica agrees.
- QABOARD_SETUP=off turns the setup page off: admins then come from QABOARD_ADMINS or `qaboard-admin create-admin`.
"""
import os
import hmac
import hashlib
import secrets
from typing import Optional


MIN_PASSWORD_LENGTH = 8
# what the setup creates by default, and QABOARD_ADMIN_PASSWORD
DEFAULT_ADMIN_USER = 'admin'


def password_problem(password) -> Optional[str]:
  """Why a password chosen by an admin or at setup isn't good enough, else None"""
  if not isinstance(password, str) or not password:
    return "Choose a password."
  if len(password) < MIN_PASSWORD_LENGTH:
    return f"Passwords need at least {MIN_PASSWORD_LENGTH} characters."
  if len(password) > 1024:
    return "This password is too long."
  return None


def user_name_problem(user_name) -> Optional[str]:
  """Why a new local account can't have this user name, else None. Same rules as sign-up (api/auth.py)."""
  from .models import User
  from .search import escape_like
  if not isinstance(user_name, str) or not user_name.strip():
    return "Choose a user name."
  if user_name != user_name.strip() or any(c.isspace() for c in user_name):
    return "User names can't have spaces."
  # service accounts are named like ci[bot] or group/repo/ci[bot] (backend/service_accounts.py)
  if any(c in user_name for c in '[]/'):
    return "User names can't have [, ] or /."
  if len(user_name) > 100:
    return "This user name is too long."
  # "ALICE" next to "alice" would be confusing, and look like an admin from $QABOARD_ADMINS
  if User.query.filter(User.user_name.ilike(escape_like(user_name), escape='\\')).first():
    return "This user name is already taken."
  return None


def email_problem(email) -> Optional[str]:
  from sqlalchemy import func
  from .models import User
  if not email:
    return None
  if not isinstance(email, str) or '@' not in email or len(email) > 320:
    return "This email doesn't look right."
  if User.query.filter(func.lower(User.email) == email.lower()).first():
    return "Another account has this email."
  return None


def generate_password() -> str:
  """For admins to give to the people they create accounts for: 16 letters and digits, easy to copy"""
  alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return ''.join(secrets.choice(alphabet) for _ in range(16))


# ——— The setup page ———

def setup_enabled() -> bool:
  from .settings import env_flag
  return env_flag(os.environ.get('QABOARD_SETUP', 'on'))


def setup_open() -> bool:
  """Whether the setup page can create the first admin: a new server, without any account yet"""
  if not setup_enabled():
    return False
  from .models import User
  return User.query.filter(User.kind == 'human').first() is None


def setup_token() -> str:
  """xxxx-xxxx-xxxx-xxxx-xxxx-xxxx: 96 bits, the same in every process and replica, that share SECRET_KEY"""
  if os.environ.get('QABOARD_SETUP_TOKEN', '').strip():
    return os.environ['QABOARD_SETUP_TOKEN'].strip()
  from backend import app
  key = app.secret_key.encode() if isinstance(app.secret_key, str) else app.secret_key
  digest = hmac.new(key, b'qaboard first admin setup token', hashlib.sha256).hexdigest()[:24]
  return '-'.join(digest[i:i + 4] for i in range(0, 24, 4))


def normalize_token(token: str) -> str:
  # people copy it from logs: spaces, dashes and case don't matter for the generated ones
  return ''.join(c for c in token.strip().lower() if c not in '- \t')


def check_setup_token(token) -> bool:
  if not isinstance(token, str) or not token.strip():
    return False
  return hmac.compare_digest(normalize_token(token).encode(), normalize_token(setup_token()).encode())


def setup_url() -> str:
  url = (os.environ.get('QABOARD_URL') or '').rstrip('/')
  return f"{url}/setup" if url else "/setup (on QA-Board's URL)"


def log_setup_token():
  print("[setup] QA-Board has no accounts yet. To create the first admin, open", setup_url(), "and enter this setup token:", flush=True)
  print(f"[setup]     {setup_token()}", flush=True)
  print("[setup] `qaboard-admin setup-token` shows it again. Automated installs can set QABOARD_ADMIN_PASSWORD instead.", flush=True)


# ——— QABOARD_ADMIN_PASSWORD ———

def env_admin_password() -> Optional[str]:
  path = os.environ.get('QABOARD_ADMIN_PASSWORD_FILE', '').strip()
  if path:
    try:
      with open(path) as f:
        return f.read().rstrip('\r\n') or None
    except OSError as e:
      print(f"[setup] WARNING: could not read QABOARD_ADMIN_PASSWORD_FILE: {type(e).__name__}", flush=True)
      return None
  return os.environ.get('QABOARD_ADMIN_PASSWORD') or None


def any_admin() -> bool:
  """Whether an active account is an admin, from the database or $QABOARD_ADMINS"""
  from sqlalchemy import or_, func
  from .models import User
  from .admins import is_admin, env_admins
  candidates = env_admins()
  emails = [a.lower() for a in candidates if '@' in a]
  query = (User.query.filter(User.status == 'active', User.kind == 'human')
           .filter(or_(User.is_admin.is_(True), User.user_name.in_(candidates), func.lower(User.email).in_(emails))))
  return any(is_admin(u) for u in query.limit(100))


def create_env_admin() -> Optional[str]:
  """
  With QABOARD_ADMIN_PASSWORD, creates the local admin QABOARD_ADMIN_USER if the server has no admin and no such user.
  Never changes existing accounts: an account someone created with that name doesn't become an admin.
  Returns what it did, for the logs, or None if there was nothing to do. Commits.
  """
  password = env_admin_password()
  if not password:
    return None
  from backend import db_session
  from .models import User
  from .admins import is_admin
  from .audit import system_audit
  user_name = (os.environ.get('QABOARD_ADMIN_USER') or DEFAULT_ADMIN_USER).strip()
  existing = User.query.filter(User.user_name == user_name).one_or_none()
  if existing is not None:
    if not is_admin(existing):
      return f"WARNING: QABOARD_ADMIN_PASSWORD is ignored: a user named {user_name} already exists, and isn't an admin"
    return None
  if any_admin():
    return None
  if problem := password_problem(password):
    return f"WARNING: QABOARD_ADMIN_PASSWORD is ignored: {problem}"
  from sqlalchemy import text
  # several processes start at once: one creates the admin
  db_session.execute(text("SELECT pg_advisory_xact_lock(hashtext('qaboard-first-admin'))"))
  if User.query.filter(User.user_name == user_name).one_or_none() is not None:
    db_session.rollback()
    return None
  user = new_local_user(user_name, password, is_admin=True)
  system_audit('user.create', label='QABOARD_ADMIN_PASSWORD', target_type='user', target_id=user.id, target_label=user.user_name,
               meta={"login_type": "LOCAL", "is_admin": True, "from": "QABOARD_ADMIN_PASSWORD"})
  db_session.commit()
  return f"Created the admin {user_name}, with the password of QABOARD_ADMIN_PASSWORD"


def new_local_user(user_name: str, password: str, full_name=None, email=None, is_admin=False):
  """An active local account (it's created by an admin, or at setup): added and flushed, the caller commits"""
  from backend import db_session
  from .models import User
  from .api.auth import generate_password_hash
  user = User(
    user_name=user_name,
    full_name=full_name or None,
    email=email or None,
    login_type='LOCAL',
    data={},
    password=generate_password_hash(password),
    status='active',
    is_admin=bool(is_admin),
  )
  db_session.add(user)
  db_session.flush()
  # the `qa` commands they ran before having an account, as this name, are theirs (backend/usage.py)
  from .usage import claim_events
  claim_events(user)
  return user


_started = False

def first_start():
  """Once per process, at its first request: QABOARD_ADMIN_PASSWORD, else the setup token in the logs"""
  global _started
  if _started:
    return
  _started = True
  from backend import db_session
  try:
    done = create_env_admin()
    if done:
      print(f"[setup] {done}", flush=True)
    if setup_open():
      log_setup_token()
  except Exception as e:
    # e.g. the database isn't migrated yet: requests must still work
    db_session.rollback()
    print(f"[setup] WARNING: could not check whether QA-Board needs a first admin: {type(e).__name__}: {e}", flush=True)
