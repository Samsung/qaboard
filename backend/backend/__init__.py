import os
from .database import db_session

# Configure the flask application
from flask import Flask
from flask_cors import CORS
app = Flask(__name__)

# This key will be used to sign session cookies
# To generate a key: python -c 'import os; print(os.urandom(16))'
def _secret_key():
    """
    Anyone knowing the key can forge sessions and log in as anyone, so we never use a hardcoded default.
    If $SECRET_KEY is not set, we generate a key once and save it, so sessions survive restarts.
    """
    if os.environ.get('SECRET_KEY'):
        return os.environ['SECRET_KEY']
    import secrets
    from .config import qaboard_data_dir
    key_path = qaboard_data_dir / 'secret_key'
    try:
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    import time
    for _ in range(50): # another worker may be writing it
        key = key_path.read_text().strip()
        if key:
            return key
        time.sleep(0.1)
    raise RuntimeError(f"Empty {key_path}")
app.secret_key = _secret_key()

# Session cookies: not readable by scripts, not sent by other websites' forms, and only over HTTPS when we're served over HTTPS
_secure_cookies = os.environ.get('QABOARD_COOKIE_SECURE', '').strip().lower() in ('1', 'true', 'yes', 'on') or os.environ.get('QABOARD_URL', '').startswith('https://')
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=_secure_cookies,
    REMEMBER_COOKIE_HTTPONLY=True,
    REMEMBER_COOKIE_SAMESITE='Lax',
    REMEMBER_COOKIE_SECURE=_secure_cookies,
    # the session's row says when it really ends (backend/sign_in/sessions.py)
    PERMANENT_SESSION_LIFETIME=365 * 24 * 3600,
)

# Errors, traces and profiles are sent to Sentry if $SENTRY_DSN is set: see backend/sentry.py
# Under uWSGI, each worker initializes Sentry after it forks (see the end of this file)
from .sentry import init_sentry, track_users
try:
  import uwsgi
  _in_uwsgi_master = uwsgi.worker_id() == 0 # with lazy-apps, workers load the app after they fork
except ImportError:
  _in_uwsgi_master = False
if not _in_uwsgi_master:
  init_sentry()
if os.environ.get('SENTRY_DSN'):
  track_users(app)

# Provide easy access to our git repositories
from .git_utils import Repos
from .git_hosts import git_hosts
from .config import qaboard_data_git_dir
repos = Repos(git_hosts, qaboard_data_git_dir)


# Some magic to use sqlalchemy safely with Flask
# http://flask.pocoo.org/docs/0.12/patterns/sqlalchemy/
from backend.database import engine, Base
@app.teardown_appcontext
def shutdown_session(exception=None):
    db_session.remove()

import backend.api.api
import backend.api.commit
import backend.api.compare
import backend.api.batch
import backend.api.outputs
import backend.api.webhooks
import backend.api.integrations
import backend.api.tuning
import backend.api.export_to_folder
import backend.api.image
import backend.api.video
import backend.api.milestones
import backend.api.auth
import backend.api.tokens
import backend.api.users
import backend.api.admin
import backend.api.sign_in
import backend.api.admin_sign_in
import backend.api.admin_jobs
import backend.api.storage
import backend.api.admin_storage
import backend.api.admin_services
import backend.api.activity
import backend.api.tasks
import backend.api.files
import backend.api.access
import backend.api.admin_access

# Who is calling, and whether they may call the API at all: see backend/actor.py
from .actor import register as register_actor
register_actor(app)

# Enable cross-origin requests to avoid development headaches
# cors = CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app)

Base.metadata.create_all(engine)


def warm_cache():
    """
    Warm up caches when a worker starts. In the background: meanwhile the worker must answer requests,
    e.g. the healthchecks of rolling deploys (fetching all the users from GitLab takes minutes).
    """
    # https://chatgpt.com/share/67c6e90f-f8b8-8000-953b-b164371166c9
    # Avoids errors
    #   > sqlalchemy.exc.OperationalError: (psycopg2.OperationalError) lost synchronization with server: got message type " "
    # https://docs.sqlalchemy.org/en/13/core/pooling.html#pooling-multiprocessing
    # https://stackoverflow.com/questions/43648075/uwsgi-flask-sqlalchemy-intermittent-postgresql-errors-with-warning-there-is-al
    # https://uwsgi-docs.readthedocs.io/en/latest/articles/TheArtOfGracefulReloading.html#preforking-vs-lazy-apps-vs-lazy
    # https://stackoverflow.com/questions/41279157/connection-problems-with-sqlalchemy-and-multiple-processes
    # close=False: the connections inherited from the uwsgi master are dropped without being closed, closing them
    # would also close them for the master and the other workers (they share the sockets).
    # https://docs.sqlalchemy.org/en/20/core/pooling.html#using-connection-pools-with-multiprocessing-or-os-fork
    engine.dispose(close=False)

    def warm():
        print("Warming cache in worker")
        from backend.git_hosts.gitlab import GitLabHost, gitlab_users
        for host in git_hosts:
            if not isinstance(host, GitLabHost) or not host.token:
                continue
            try:
                users = gitlab_users(host)  # also stored in redis, shared with the other workers
            except Exception as e:
                print(f"WARNING: could not warm the users cache for {host}: {e}")
                continue
            print(f"Loaded info about {len(users)} users from {host}")

    import threading
    threading.Thread(target=warm, name="warm-cache", daemon=True).start()

def post_fork():
  init_sentry()
  warm_cache()

try:
  import uwsgi
  uwsgi.post_fork_hook = post_fork
except ImportError:
  pass

