import os
from .database import db_session, Session

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

if os.environ.get('FLASK_ENV') == 'production' and os.environ.get('SENTRY_DSN'):
    # send errors to sentry server
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration

    # TODO: add IT's certificate and remove this...
    import urllib3
    urllib3.disable_warnings()
    class InsecureHttpTransport(sentry_sdk.transport.HttpTransport):
        def _get_pool_options(self):
            options = super()._get_pool_options()
            options["cert_reqs"] = "CERT_NONE" # Ignore SSL Errors
            return options

    sentry_sdk.init(
        dsn=os.environ.get('SENTRY_DSN'),
        integrations=[
            FlaskIntegration(),
        ],
        traces_sample_rate=float(os.environ.get('SENTRY_SAMPLE_RATE', 0.2)),
        transport=InsecureHttpTransport, # TODO: remove this...
        # ca_certs="some/place/sirc-certificate-authority.pem"
    )

# Provide easy access to our git repositories
from .git_utils import Repos
from .config import git_server, qaboard_data_git_dir
repos = Repos(git_server, qaboard_data_git_dir)


# Some magic to use sqlalchemy safely with Flask
# http://flask.pocoo.org/docs/0.12/patterns/sqlalchemy/
from backend.database import db_session, engine, Base
@app.teardown_appcontext
def shutdown_session(exception=None):
    db_session.remove()

import backend.api.api
import backend.api.commit
import backend.api.batch
import backend.api.outputs
import backend.api.webhooks
import backend.api.integrations
import backend.api.tuning
import backend.api.export_to_folder
import backend.api.image
import backend.api.milestones
import backend.api.auth
import backend.api.tasks
import backend.api.files

# Enable cross-origin requests to avoid development headcaches  
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
    engine.dispose()

    def warm():
        print("Warming cache in worker")
        from backend.utils import get_users_per_name
        try:
            users = get_users_per_name("")  # also stored in redis, shared with the other workers
        except Exception as e:
            print(f"WARNING: could not warm the users cache: {e}")
            return
        print(f"Loaded info about {len(users)} users")

    import threading
    threading.Thread(target=warm, name="warm-cache", daemon=True).start()

try:
  import uwsgi
  uwsgi.post_fork_hook = warm_cache
except:
  pass

