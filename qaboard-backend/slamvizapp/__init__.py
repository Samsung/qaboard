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
from .config import git_server, app_data_directory
repos = Repos(git_server, app_data_directory)


# We could fetch the latest commits at startup
# TODO: find which projects to pull using the latest commits in the database
# from .git_utils import git_pull
# default_repo = repos['dvs/psp_swip']
# git_pull(default_repo)

# Some magic to use sqlalchemy safely with Flask
# http://flask.pocoo.org/docs/0.12/patterns/sqlalchemy/
from slamvizapp.database import db_session
@app.teardown_appcontext
def shutdown_session(exception=None):
    db_session.remove()

import slamvizapp.api.api
import slamvizapp.api.webhooks
import slamvizapp.api.integrations
import slamvizapp.api.tuning
import slamvizapp.api.export_to_folder
import slamvizapp.api.auto_rois
import slamvizapp.api.milestones
import slamvizapp.admin

# Enable cross-origin requests to avoid development headcaches  
# cors = CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app)
