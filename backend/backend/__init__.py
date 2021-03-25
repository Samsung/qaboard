import os
from .database import db_session, Session

# Configure the flask application
from flask import Flask
from flask_cors import CORS
app = Flask(__name__)

# This would be needed to use flask's sessions (e.g. display flash messages after redirects...)
# However we never used this feature as (1) the backend is stateless and (2) the client uses an API, now generated views. 
app.secret_key = os.environ.get('QABOARD_FLASK_SECRET_KEY', 'xxxxxxxxxxx')

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
import backend.api.auto_rois
import backend.api.milestones
import backend.api.auth

# Enable cross-origin requests to avoid development headcaches  
# cors = CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app)

Base.metadata.create_all(engine)

# Avoids errors
#   > sqlalchemy.exc.OperationalError: (psycopg2.OperationalError) lost synchronization with server: got message type " "
# https://docs.sqlalchemy.org/en/13/core/pooling.html#pooling-multiprocessing
# https://stackoverflow.com/questions/43648075/uwsgi-flask-sqlalchemy-intermittent-postgresql-errors-with-warning-there-is-al
# https://uwsgi-docs.readthedocs.io/en/latest/articles/TheArtOfGracefulReloading.html#preforking-vs-lazy-apps-vs-lazy
# https://stackoverflow.com/questions/41279157/connection-problems-with-sqlalchemy-and-multiple-processes
engine.dispose()
