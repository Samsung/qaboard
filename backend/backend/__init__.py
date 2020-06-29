import os
from .database import db_session, Session

# Configure the flask application
from flask import Flask
from flask_cors import CORS
app = Flask(__name__)

# This would be needed to use flask's sessions (e.g. display flash messages after redirects...)
# However we never used this feature as (1) the backend is stateless and (2) the client uses an API, now generated views. 
# app.secret_key = os.environ.get('QABOARD_FLASK_SECRET_KEY', 'xxxxxxxxxxx')

# Provide easy access to our git repositories
from .git_utils import Repos
from .config import git_server, qaboard_data_dir
repos = Repos(git_server, qaboard_data_dir / 'git')


# Some magic to use sqlalchemy safely with Flask
# http://flask.pocoo.org/docs/0.12/patterns/sqlalchemy/
from backend.database import db_session, engine, Base
@app.teardown_appcontext
def shutdown_session(exception=None):
    db_session.remove()

import backend.api.api
import backend.api.webhooks
import backend.api.integrations
import backend.api.tuning
import backend.api.export_to_folder
import backend.api.auto_rois
import backend.api.milestones

# Enable cross-origin requests to avoid development headcaches  
# cors = CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app)

Base.metadata.create_all(engine)