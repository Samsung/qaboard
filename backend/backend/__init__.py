from .database import db_session, Session

# Configure the flask application
from flask import Flask
from flask_cors import CORS
app = Flask(__name__)

# This is needed to use flask's sessions
# and eg display flash messages after redirects
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'

# Provide easy access to our git repositories
from .git_utils import Repos
from .config import git_server, qaboard_data_dir
repos = Repos(git_server, qaboard_data_dir / 'git')


# We could fetch the latest commits at startup
# TODO: find which projects to pull using the latest commits in the database
# from .git_utils import git_pull
# default_repo = repos['dvs/psp_swip']
# git_pull(default_repo)

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
import backend.admin

# Enable cross-origin requests to avoid development headcaches  
# cors = CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app)

Base.metadata.create_all(engine)